#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(target_os = "macos")]
use std::fs::{self, OpenOptions};
#[cfg(target_os = "macos")]
use std::io::Write;
#[cfg(target_os = "macos")]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HERDR_BIN_ENV: &str = "QE_HERDR_BIN";
const HERDR_RUNTIME_UNAVAILABLE: &str = "Compatible Quest Engineering Herdr runtime unavailable. Configure QE_HERDR_BIN with an absolute executable path.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAttachment {
    mode: String,
    backend_kind: String,
    terminal_session_id: String,
    pane_id: String,
    terminal_id: Option<String>,
    worker_id: String,
    session_id: String,
    takeover_allowed: bool,
    recovery_allowed: bool,
}

#[tauri::command]
fn open_live_session(descriptor: LocalAttachment, interaction_mode: String) -> Result<(), String> {
    if descriptor.mode != "local_native_terminal" || descriptor.backend_kind != "herdr" {
        return Err("Unsupported local terminal attachment transport.".into());
    }
    if interaction_mode == "takeover" && !descriptor.takeover_allowed {
        return Err("Interactive takeover is not allowed for this session state.".into());
    }
    if interaction_mode == "recovery" && !descriptor.recovery_allowed {
        return Err("Interactive recovery is not allowed for this session state.".into());
    }
    if !matches!(
        interaction_mode.as_str(),
        "observe" | "takeover" | "recovery"
    ) {
        return Err("Unsupported live-session interaction mode.".into());
    }
    validate_session_name(&descriptor.terminal_session_id)?;
    validate_herdr_pane_id(&descriptor.pane_id)?;

    let herdr = resolve_herdr_executable()?;
    let sessions = Command::new(&herdr)
        .args(["session", "list", "--json"])
        .output()
        .map_err(|_| "Could not inspect local Herdr sessions.".to_string())?;
    if !sessions.status.success() {
        return Err(HERDR_RUNTIME_UNAVAILABLE.into());
    }
    let session_running = session_is_running(&sessions.stdout, &descriptor.terminal_session_id)
        .map_err(|_| HERDR_RUNTIME_UNAVAILABLE.to_string())?;
    if !session_running {
        return Err("The referenced Worker session is not running on this host.".into());
    }

    let output = Command::new(&herdr)
        .args([
            "--session",
            &descriptor.terminal_session_id,
            "agent",
            "get",
            &descriptor.pane_id,
        ])
        .output()
        .map_err(|_| "Could not inspect the local Herdr session.".to_string())?;
    if !output.status.success() {
        return Err("The referenced Worker session is not available on this host.".into());
    }
    let agent: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| HERDR_RUNTIME_UNAVAILABLE.to_string())?;
    if !json_contains_field(&agent, &["qe_owner"], "quest-engineering-worker/v1")
        || !json_contains_field(&agent, &["qe_worker_id"], &descriptor.worker_id)
        || !json_contains_field(&agent, &["qe_lineage_id"], &descriptor.session_id)
    {
        return Err(
            "The local Herdr target is not the referenced Quest Engineering execution session."
                .into(),
        );
    }
    if let Some(expected_terminal) = &descriptor.terminal_id {
        if !json_contains_field(&agent, &["terminal_id"], expected_terminal) {
            return Err("The local terminal identity does not match the execution session.".into());
        }
    }
    if interaction_mode == "takeover"
        && !json_contains_field(&agent, &["status", "agent_status"], "blocked")
    {
        return Err("The coding agent is no longer waiting for interactive takeover.".into());
    }

    #[cfg(target_os = "macos")]
    {
        let launch = TerminalAttachLaunch {
            herdr_path: herdr,
            terminal_session_id: descriptor.terminal_session_id,
            pane_id: descriptor.pane_id,
            interaction_mode,
            home: std::env::var_os("HOME").map(PathBuf::from),
            xdg_config_home: std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
            herdr_config_path: std::env::var_os("HERDR_CONFIG_PATH").map(PathBuf::from),
        };
        return open_terminal_attachment(&launch);
    }

    #[cfg(not(target_os = "macos"))]
    Err("Native Herdr attachment is currently implemented for macOS only.".into())
}

fn resolve_herdr_executable() -> Result<PathBuf, String> {
    let configured = std::env::var_os(HERDR_BIN_ENV).ok_or(HERDR_RUNTIME_UNAVAILABLE)?;
    validate_herdr_executable_path(Path::new(&configured))
}

fn validate_herdr_executable_path(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(HERDR_RUNTIME_UNAVAILABLE.into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| HERDR_RUNTIME_UNAVAILABLE)?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| HERDR_RUNTIME_UNAVAILABLE)?;
    if !metadata.is_file() {
        return Err(HERDR_RUNTIME_UNAVAILABLE.into());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(HERDR_RUNTIME_UNAVAILABLE.into());
    }
    Ok(canonical)
}

fn validate_session_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err("Invalid Herdr session identity.".into());
    }
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
fn validate_agent_name(value: &str) -> Result<(), String> {
    let mut bytes = value.bytes();
    let first = bytes.next();
    if value.len() > 32
        || !matches!(first, Some(byte) if byte.is_ascii_lowercase())
        || !bytes
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte))
    {
        return Err("Invalid Herdr agent identity.".into());
    }
    Ok(())
}

fn validate_herdr_pane_id(value: &str) -> Result<(), String> {
    let Some(value) = value.strip_prefix('w') else {
        return Err("Invalid Herdr pane identity.".into());
    };
    let Some((workspace, pane)) = value.split_once(":p") else {
        return Err("Invalid Herdr pane identity.".into());
    };
    if !valid_herdr_public_number(workspace) || !valid_herdr_public_number(pane) {
        return Err("Invalid Herdr pane identity.".into());
    }
    Ok(())
}

fn valid_herdr_public_number(value: &str) -> bool {
    const PUBLIC_ID_ALPHABET: &[u8] = b"123456789ABCDEFGHJKMNPQRSTVWXYZ0";
    !value.is_empty()
        && value.len() <= 13
        && value.bytes().all(|byte| PUBLIC_ID_ALPHABET.contains(&byte))
}

fn session_is_running(bytes: &[u8], expected: &str) -> Result<bool, ()> {
    let value = serde_json::from_slice::<serde_json::Value>(bytes).map_err(|_| ())?;
    let sessions = value
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .ok_or(())?;
    Ok(sessions.iter().any(|session| {
        session.get("name").and_then(serde_json::Value::as_str) == Some(expected)
            && session.get("running").and_then(serde_json::Value::as_bool) == Some(true)
    }))
}

fn json_contains_field(value: &serde_json::Value, keys: &[&str], expected: &str) -> bool {
    match value {
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| json_contains_field(value, keys, expected)),
        serde_json::Value::Object(values) => values.iter().any(|(key, value)| {
            (keys.contains(&key.as_str()) && value.as_str() == Some(expected))
                || json_contains_field(value, keys, expected)
        }),
        _ => false,
    }
}

#[cfg(target_os = "macos")]
const ATTACH_LAUNCHER_NAME: &str = "quest-engineering-session-attach";
#[cfg(target_os = "macos")]
static ATTACH_LAUNCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalAttachLaunch {
    herdr_path: PathBuf,
    terminal_session_id: String,
    pane_id: String,
    interaction_mode: String,
    home: Option<PathBuf>,
    xdg_config_home: Option<PathBuf>,
    herdr_config_path: Option<PathBuf>,
}

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
struct TerminalAttachStatus {
    state: String,
    message: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
struct NativeCommandSpec {
    executable: PathBuf,
    args: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
}

#[cfg(target_os = "macos")]
fn herdr_attach_command(launch: &TerminalAttachLaunch) -> Result<NativeCommandSpec, String> {
    validate_session_name(&launch.terminal_session_id)?;
    validate_herdr_pane_id(&launch.pane_id)?;
    if !matches!(
        launch.interaction_mode.as_str(),
        "observe" | "takeover" | "recovery"
    ) {
        return Err("Unsupported live-session interaction mode.".into());
    }
    let herdr_path = validate_herdr_executable_path(&launch.herdr_path)?;

    let mut args = vec![
        OsString::from("--session"),
        launch.terminal_session_id.clone().into(),
        OsString::from("agent"),
        OsString::from("attach"),
        launch.pane_id.clone().into(),
    ];
    if launch.interaction_mode != "observe" {
        args.push(OsString::from("--takeover"));
    }
    let mut environment = Vec::new();
    for (name, value) in [
        ("HOME", launch.home.as_ref()),
        ("XDG_CONFIG_HOME", launch.xdg_config_home.as_ref()),
        ("HERDR_CONFIG_PATH", launch.herdr_config_path.as_ref()),
    ] {
        if let Some(value) = value {
            environment.push((OsString::from(name), value.as_os_str().to_owned()));
        }
    }
    Ok(NativeCommandSpec {
        executable: herdr_path,
        args,
        environment,
    })
}

#[cfg(target_os = "macos")]
fn open_terminal_attachment(launch: &TerminalAttachLaunch) -> Result<(), String> {
    let _ = herdr_attach_command(launch)?;
    let directory = create_attachment_launch_directory()?;
    let launcher_path = directory.join(ATTACH_LAUNCHER_NAME);
    let descriptor_path = directory.join("launch.json");
    let status_path = directory.join("status.json");
    let current_executable = std::env::current_exe()
        .map_err(|_| "Could not locate the native session-attach launcher.".to_string())?;

    fs::copy(&current_executable, &launcher_path)
        .map_err(|_| "Could not prepare the native session-attach launcher.".to_string())?;
    fs::set_permissions(&launcher_path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Could not secure the native session-attach launcher.".to_string())?;
    write_private_json(&descriptor_path, launch)
        .map_err(|_| "Could not prepare the native session-attach descriptor.".to_string())?;

    let opened = Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(&launcher_path)
        .status()
        .map_err(|_| "Could not open the local terminal application.".to_string())?;
    if !opened.success() {
        cleanup_attachment_launch_directory(&directory);
        return Err("The terminal application rejected the attach request.".into());
    }

    for _ in 0..100 {
        if let Ok(bytes) = fs::read(&status_path) {
            let status: TerminalAttachStatus = serde_json::from_slice(&bytes).map_err(|_| {
                "The native session-attach launcher returned invalid status.".to_string()
            })?;
            cleanup_attachment_launch_directory(&directory);
            return if status.state == "started" {
                Ok(())
            } else {
                Err(status
                    .message
                    .unwrap_or_else(|| "The native session-attach launcher failed.".into()))
            };
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    cleanup_attachment_launch_directory(&directory);
    Err("The native session-attach launcher did not start.".into())
}

#[cfg(target_os = "macos")]
fn create_attachment_launch_directory() -> Result<PathBuf, String> {
    let root = std::env::var_os("QE_SESSION_ATTACH_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("quest-engineering-session-attach"));
    if !root.is_absolute() {
        return Err("The native session-attach root must be absolute.".into());
    }
    fs::create_dir_all(&root)
        .map_err(|_| "Could not create the native session-attach root.".to_string())?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Could not secure the native session-attach root.".to_string())?;

    for _ in 0..100 {
        let sequence = ATTACH_LAUNCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = root.join(format!("launch-{}-{nanos}-{sequence}", std::process::id()));
        match fs::create_dir(&directory) {
            Ok(()) => {
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(
                    |_| "Could not secure the native session-attach directory.".to_string(),
                )?;
                return Ok(directory);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err("Could not create the native session-attach directory.".into());
            }
        }
    }
    Err("Could not allocate a native session-attach directory.".into())
}

#[cfg(target_os = "macos")]
fn write_private_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()
}

#[cfg(target_os = "macos")]
fn write_launcher_status(path: &Path, status: &TerminalAttachStatus) -> std::io::Result<()> {
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    write_private_json(&temporary, status)?;
    fs::rename(temporary, path)
}

#[cfg(target_os = "macos")]
fn cleanup_attachment_launch_directory(directory: &Path) {
    let _ = fs::remove_file(directory.join("launch.json"));
    let _ = fs::remove_file(directory.join("status.json"));
    let _ = fs::remove_file(directory.join("status.tmp"));
    let _ = fs::remove_file(directory.join(ATTACH_LAUNCHER_NAME));
    let _ = fs::remove_dir(directory);
}

#[cfg(target_os = "macos")]
fn attachment_launcher_directory() -> Option<PathBuf> {
    let invoked_as = PathBuf::from(std::env::args_os().next()?);
    if invoked_as.file_name()?.to_str()? != ATTACH_LAUNCHER_NAME {
        return None;
    }
    let directory = invoked_as.parent()?.to_path_buf();
    if !directory.file_name()?.to_str()?.starts_with("launch-") {
        return None;
    }
    Some(directory)
}

#[cfg(target_os = "macos")]
fn run_terminal_attachment_launcher(directory: &Path) -> i32 {
    let descriptor_path = directory.join("launch.json");
    let status_path = directory.join("status.json");
    let result = (|| -> Result<i32, String> {
        let bytes = fs::read(&descriptor_path)
            .map_err(|_| "The native session-attach descriptor is unavailable.".to_string())?;
        let launch: TerminalAttachLaunch = serde_json::from_slice(&bytes)
            .map_err(|_| "The native session-attach descriptor is invalid.".to_string())?;
        let command = herdr_attach_command(&launch)?;
        let _ = fs::remove_file(&descriptor_path);

        let mut process = Command::new(&command.executable);
        process.args(&command.args);
        for (name, value) in &command.environment {
            process.env(name, value);
        }
        let mut child = process
            .spawn()
            .map_err(|_| "Could not start the pinned Herdr attachment.".to_string())?;
        std::thread::sleep(Duration::from_millis(100));
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Could not inspect the pinned Herdr attachment.".to_string())?
        {
            return Err(format!(
                "The pinned Herdr attachment exited before becoming observable ({status})."
            ));
        }
        write_launcher_status(
            &status_path,
            &TerminalAttachStatus {
                state: "started".into(),
                message: None,
            },
        )
        .map_err(|_| "Could not acknowledge the native Herdr attachment.".to_string())?;
        let status = child
            .wait()
            .map_err(|_| "Could not wait for the native Herdr attachment.".to_string())?;
        Ok(status.code().unwrap_or(1))
    })();

    match result {
        Ok(code) => code,
        Err(message) => {
            let _ = write_launcher_status(
                &status_path,
                &TerminalAttachStatus {
                    state: "failed".into(),
                    message: Some(message),
                },
            );
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn write_test_executable(path: &Path, body: &str, mode: u32) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    fn resolver_test_directory() -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("native-herdr-resolver-tests")
            .join(format!("{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(unix)]
    fn run_resolver_subprocess(
        mode: &str,
        configured: &Path,
        hostile_path: &OsString,
        explicit_marker: &Path,
        trap_marker: &Path,
    ) {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::herdr_resolver_subprocess",
                "--ignored",
                "--nocapture",
            ])
            .env("QE_NATIVE_HERDR_RESOLVER_TEST_MODE", mode)
            .env(HERDR_BIN_ENV, configured)
            .env("PATH", hostile_path)
            .env("QE_HERDR_TEST_EXPLICIT_MARKER", explicit_marker)
            .env("QE_HERDR_TEST_TRAP_MARKER", trap_marker)
            .status()
            .unwrap();
        assert!(status.success(), "resolver subprocess failed for {mode}");
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "helper invoked by configured_herdr_bypasses_hostile_path_and_fails_closed"]
    fn herdr_resolver_subprocess() {
        let Ok(mode) = std::env::var("QE_NATIVE_HERDR_RESOLVER_TEST_MODE") else {
            return;
        };
        match mode.as_str() {
            "explicit" => {
                let resolved = resolve_herdr_executable().unwrap();
                assert_eq!(
                    resolved,
                    std::fs::canonicalize(std::env::var_os(HERDR_BIN_ENV).unwrap()).unwrap()
                );
                assert!(Command::new(resolved)
                    .arg("--probe")
                    .status()
                    .unwrap()
                    .success());
            }
            "missing" | "non-executable" => {
                assert_eq!(
                    resolve_herdr_executable().unwrap_err(),
                    HERDR_RUNTIME_UNAVAILABLE
                );
            }
            other => panic!("unexpected resolver test mode {other}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn configured_herdr_bypasses_hostile_path_and_fails_closed() {
        assert_eq!(HERDR_BIN_ENV, "QE_HERDR_BIN");
        let root = resolver_test_directory();
        let controlled = root.join("controlled-herdr");
        let missing = root.join("missing-herdr");
        let non_executable = root.join("non-executable-herdr");
        let hostile_directory = root.join("hostile");
        let hostile = hostile_directory.join("herdr");
        let explicit_marker = root.join("explicit-invocations");
        let trap_marker = root.join("path-trap-invocations");
        std::fs::create_dir_all(&hostile_directory).unwrap();
        write_test_executable(
            &controlled,
            "#!/bin/sh\nprintf 'explicit\\n' >> \"$QE_HERDR_TEST_EXPLICIT_MARKER\"\n",
            0o755,
        );
        write_test_executable(
            &hostile,
            "#!/bin/sh\nprintf 'trap\\n' >> \"$QE_HERDR_TEST_TRAP_MARKER\"\n",
            0o755,
        );
        write_test_executable(&non_executable, "#!/bin/sh\nexit 0\n", 0o644);
        let hostile_path = std::env::join_paths(
            std::iter::once(hostile_directory.clone()).chain(
                std::env::var_os("PATH")
                    .into_iter()
                    .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>()),
            ),
        )
        .unwrap();

        run_resolver_subprocess(
            "explicit",
            &controlled,
            &hostile_path,
            &explicit_marker,
            &trap_marker,
        );
        run_resolver_subprocess(
            "missing",
            &missing,
            &hostile_path,
            &explicit_marker,
            &trap_marker,
        );
        run_resolver_subprocess(
            "non-executable",
            &non_executable,
            &hostile_path,
            &explicit_marker,
            &trap_marker,
        );

        assert_eq!(
            std::fs::read_to_string(&explicit_marker).unwrap(),
            "explicit\n"
        );
        assert!(!trap_marker.exists(), "PATH Herdr trap was invoked");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unconfigured_or_relative_herdr_runtime() {
        assert_eq!(
            validate_herdr_executable_path(Path::new("herdr")).unwrap_err(),
            HERDR_RUNTIME_UNAVAILABLE
        );
        assert_eq!(
            validate_herdr_executable_path(Path::new("./herdr")).unwrap_err(),
            HERDR_RUNTIME_UNAVAILABLE
        );
        assert_eq!(
            validate_herdr_executable_path(Path::new("")).unwrap_err(),
            HERDR_RUNTIME_UNAVAILABLE
        );
    }

    #[test]
    fn validates_distinct_herdr_identifier_domains() {
        assert!(validate_session_name("quest-engineering-worker").is_ok());
        assert!(validate_agent_name("qe-1234-review").is_ok());
        assert!(validate_herdr_pane_id("w2:p2").is_ok());
        assert!(validate_herdr_pane_id("w12:p7").is_ok());
        assert!(validate_herdr_pane_id("wA:pZ0").is_ok());

        assert!(validate_session_name("bad; command").is_err());
        assert!(validate_agent_name("Bad Agent").is_err());
        assert!(validate_agent_name("w2:p2").is_err());
    }

    #[test]
    fn rejects_malformed_or_unsafe_herdr_pane_ids() {
        for value in [
            "",
            " ",
            "w2",
            "p2",
            "w:p2",
            "w2:p",
            "w2:p2:p3",
            "w2:t2",
            "session-name",
            "w2/p2",
            "../w2:p2",
            "w2:p2;open",
            "w2:p2\nnext",
            "w2:p2\r",
            "w2:p2\0",
            "w2:p2$()",
            "w2:p2 with-space",
            "wabcdefghijklmn:p1",
            "w1:pabcdefghijklmn",
            "W2:P2",
            "wI:p1",
            "w1:pO",
        ] {
            assert!(
                validate_herdr_pane_id(value).is_err(),
                "unexpectedly accepted {value:?}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn constructs_inputless_and_takeover_herdr_argv_without_shell_source() {
        let executable = std::env::current_exe().unwrap();
        let mut launch = TerminalAttachLaunch {
            herdr_path: executable.clone(),
            terminal_session_id: "worker-session".into(),
            pane_id: "w12:p7".into(),
            interaction_mode: "observe".into(),
            home: Some(PathBuf::from("/control/home")),
            xdg_config_home: Some(PathBuf::from("/control/xdg")),
            herdr_config_path: Some(PathBuf::from("/control/herdr.toml")),
        };
        let observe = herdr_attach_command(&launch).unwrap();
        assert_eq!(observe.executable, executable);
        assert_eq!(
            observe.args,
            ["--session", "worker-session", "agent", "attach", "w12:p7"].map(OsString::from)
        );
        assert_eq!(observe.args[4], OsString::from("w12:p7"));
        assert!(!observe.args.contains(&OsString::from("--takeover")));

        launch.interaction_mode = "takeover".into();
        let takeover = herdr_attach_command(&launch).unwrap();
        assert_eq!(takeover.args[4], OsString::from("w12:p7"));
        assert_eq!(takeover.args.last(), Some(&OsString::from("--takeover")));
    }

    #[test]
    fn requires_an_existing_running_named_session() {
        let body = br#"{"sessions":[{"name":"worker-a","running":true},{"name":"worker-b","running":false}]}"#;
        assert_eq!(session_is_running(body, "worker-a"), Ok(true));
        assert_eq!(session_is_running(body, "worker-b"), Ok(false));
        assert_eq!(session_is_running(body, "worker-c"), Ok(false));
        assert_eq!(session_is_running(b"not-json", "worker-a"), Err(()));
        let agent: serde_json::Value = serde_json::from_str(
            r#"{"result":{"agent":{"status":"blocked","tokens":{"qe_owner":"quest-engineering-worker/v1","qe_worker_id":"worker-a","qe_lineage_id":"session-a"}}}}"#,
        )
        .unwrap();
        assert!(json_contains_field(
            &agent,
            &["status", "agent_status"],
            "blocked"
        ));
        assert!(json_contains_field(&agent, &["qe_worker_id"], "worker-a"));
        assert!(!json_contains_field(&agent, &["qe_lineage_id"], "other"));
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    if let Some(directory) = attachment_launcher_directory() {
        std::process::exit(run_terminal_attachment_launcher(&directory));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![open_live_session])
        .run(tauri::generate_context!())
        .expect("error while running Quest Engineering client");
}
