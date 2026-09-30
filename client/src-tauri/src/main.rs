#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "macos")]
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::io::{BufRead, BufReader};
#[cfg(target_os = "macos")]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(target_os = "macos")]
use std::os::unix::process::ExitStatusExt;
#[cfg(target_os = "macos")]
use std::process::ExitStatus;
#[cfg(target_os = "macos")]
use std::sync::{mpsc, Arc, Condvar, Mutex};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter};

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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HERDR_BIN_ENV: &str = "QE_HERDR_BIN";
const HERDR_CONFIG_HOME_ENV: &str = "XDG_CONFIG_HOME";
const HERDR_CONFIG_PATH_ENV: &str = "HERDR_CONFIG_PATH";
const HERDR_CONTEXT_VERSION: &str = "qe-herdr-local-context-v1";
const HERDR_RUNTIME_UNAVAILABLE: &str = "Compatible Quest Engineering Herdr runtime unavailable. Configure QE_HERDR_BIN with an absolute executable path.";
const HERDR_CONTEXT_UNAVAILABLE: &str = "Compatible Quest Engineering Herdr session context unavailable. Configure XDG_CONFIG_HOME and HERDR_CONFIG_PATH as absolute existing paths shared by the Worker and desktop.";
const HERDR_CONTEXT_MISMATCH: &str = "The desktop Herdr session context does not match the Worker context. Ensure the Worker and desktop use the same QE_HERDR_BIN, XDG_CONFIG_HOME, and HERDR_CONFIG_PATH.";
const HERDR_SESSION_CONTEXT_MISMATCH: &str = "The configured Herdr session namespace does not contain the referenced Worker session. Ensure the Worker and desktop use the same XDG_CONFIG_HOME and HERDR_CONFIG_PATH.";
const HERDR_TRANSIENT_ENV: &[&str] = &[
    "HERDR_SESSION",
    "HERDR_SOCKET_PATH",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_PANE_ID",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAttachment {
    mode: String,
    backend_kind: String,
    terminal_session_id: String,
    local_context_id: String,
    pane_id: String,
    terminal_id: Option<String>,
    worker_id: String,
    session_id: String,
    takeover_allowed: bool,
    recovery_allowed: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSessionOwner {
    run_id: String,
    occurrence_id: String,
    attempt_id: String,
    session_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalObservationStatus {
    local_session_id: String,
    run_id: String,
    occurrence_id: String,
    attempt_id: String,
    session_id: String,
    terminal_session_id: String,
    pane_id: String,
    terminal_id: Option<String>,
    mode: String,
    state: String,
    reason: Option<String>,
}

impl LocalObservationStatus {
    fn same_attachment(&self, other: &Self) -> bool {
        self.local_session_id == other.local_session_id
            && self.run_id == other.run_id
            && self.occurrence_id == other.occurrence_id
            && self.attempt_id == other.attempt_id
            && self.session_id == other.session_id
            && self.terminal_session_id == other.terminal_session_id
            && self.pane_id == other.pane_id
            && self.terminal_id == other.terminal_id
            && self.mode == other.mode
    }
}

#[cfg(target_os = "macos")]
struct LocalObservationEntry {
    status: Mutex<LocalObservationStatus>,
    changed: Condvar,
    control: Mutex<UnixStream>,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct LocalObservationRegistry {
    sessions: Mutex<HashMap<String, Arc<LocalObservationEntry>>>,
}

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
struct LocalObservationRegistry;

#[derive(Debug, Clone, PartialEq, Eq)]
struct HerdrLocalContext {
    executable: PathBuf,
    config_home: PathBuf,
    config_path: PathBuf,
    id: String,
}

#[tauri::command]
fn open_live_session(
    descriptor: LocalAttachment,
    interaction_mode: String,
    owner: LocalSessionOwner,
    app: tauri::AppHandle,
    registry: tauri::State<'_, LocalObservationRegistry>,
) -> Result<LocalObservationStatus, String> {
    if descriptor.mode != "local_native_terminal" || descriptor.backend_kind != "herdr" {
        return Err("Unsupported local terminal attachment transport.".into());
    }
    if owner.session_id != descriptor.session_id {
        return Err("The local observation owner does not match the execution session.".into());
    }
    validate_local_session_owner(&owner)?;
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
    let context = resolve_herdr_local_context()?;
    require_matching_herdr_context(&descriptor.local_context_id, &context)?;
    eprintln!(
        "QE Herdr local context resolved: executable={} config_home={} config_path={} context_id={}",
        context.executable.display(),
        context.config_home.display(),
        context.config_path.display(),
        context.id
    );
    let sessions = herdr_output(&context, &["session", "list", "--json"])
        .map_err(|_| "Could not inspect local Herdr sessions.".to_string())?;
    if !sessions.status.success() {
        return Err(HERDR_RUNTIME_UNAVAILABLE.into());
    }
    let session_running = session_is_running(&sessions.stdout, &descriptor.terminal_session_id)
        .map_err(|_| HERDR_RUNTIME_UNAVAILABLE.to_string())?;
    if !session_running {
        return Err(HERDR_SESSION_CONTEXT_MISMATCH.into());
    }

    let output = herdr_output(
        &context,
        &[
            "--session",
            &descriptor.terminal_session_id,
            "agent",
            "get",
            &descriptor.pane_id,
        ],
    )
    .map_err(|_| "Could not inspect the local Herdr session.".to_string())?;
    if !output.status.success() {
        return Err(
            "The referenced Worker session is not available in the configured Herdr context."
                .into(),
        );
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
        let status = LocalObservationStatus {
            local_session_id: new_local_session_id(&owner, &descriptor),
            run_id: owner.run_id,
            occurrence_id: owner.occurrence_id,
            attempt_id: owner.attempt_id,
            session_id: owner.session_id,
            terminal_session_id: descriptor.terminal_session_id.clone(),
            pane_id: descriptor.pane_id.clone(),
            terminal_id: descriptor.terminal_id.clone(),
            mode: interaction_mode.clone(),
            state: "attached".into(),
            reason: None,
        };
        let launch = TerminalAttachLaunch {
            herdr_path: context.executable,
            terminal_session_id: descriptor.terminal_session_id,
            pane_id: descriptor.pane_id,
            interaction_mode,
            home: std::env::var_os("HOME").map(PathBuf::from),
            xdg_config_home: context.config_home,
            herdr_config_path: context.config_path,
        };
        let opened = open_terminal_attachment(&launch, &status)?;
        register_local_observation(&registry, &app, status.clone(), opened)?;
        Ok(status)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, registry);
        Err("Native Herdr attachment is currently implemented for macOS only.".into())
    }
}

#[tauri::command]
fn close_live_session(
    session: LocalObservationStatus,
    registry: tauri::State<'_, LocalObservationRegistry>,
) -> Result<LocalObservationStatus, String> {
    #[cfg(target_os = "macos")]
    {
        close_local_observation(&registry, &session)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session, registry);
        Err("Native Herdr attachment is currently implemented for macOS only.".into())
    }
}

fn resolve_herdr_executable() -> Result<PathBuf, String> {
    let configured = std::env::var_os(HERDR_BIN_ENV).ok_or(HERDR_RUNTIME_UNAVAILABLE)?;
    validate_herdr_executable_path(Path::new(&configured))
}

fn resolve_herdr_local_context() -> Result<HerdrLocalContext, String> {
    let executable = resolve_herdr_executable()?;
    let config_home = canonical_context_path(HERDR_CONFIG_HOME_ENV, true)?;
    let config_path = canonical_context_path(HERDR_CONFIG_PATH_ENV, false)?;
    let id = herdr_local_context_id(&executable, &config_home, &config_path)?;
    Ok(HerdrLocalContext {
        executable,
        config_home,
        config_path,
        id,
    })
}

fn canonical_context_path(name: &str, directory: bool) -> Result<PathBuf, String> {
    let configured = std::env::var_os(name).ok_or(HERDR_CONTEXT_UNAVAILABLE)?;
    let path = PathBuf::from(configured);
    if !path.is_absolute() {
        return Err(HERDR_CONTEXT_UNAVAILABLE.into());
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| HERDR_CONTEXT_UNAVAILABLE)?;
    let metadata = std::fs::metadata(&canonical).map_err(|_| HERDR_CONTEXT_UNAVAILABLE)?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(HERDR_CONTEXT_UNAVAILABLE.into());
    }
    Ok(canonical)
}

fn herdr_local_context_id(
    executable: &Path,
    config_home: &Path,
    config_path: &Path,
) -> Result<String, String> {
    let executable = executable
        .to_str()
        .ok_or_else(|| HERDR_CONTEXT_UNAVAILABLE.to_string())?;
    let config_home = config_home
        .to_str()
        .ok_or_else(|| HERDR_CONTEXT_UNAVAILABLE.to_string())?;
    let config_path = config_path
        .to_str()
        .ok_or_else(|| HERDR_CONTEXT_UNAVAILABLE.to_string())?;
    let mut digest = Sha256::new();
    digest.update(HERDR_CONTEXT_VERSION.as_bytes());
    digest.update([0]);
    digest.update(executable.as_bytes());
    digest.update([0]);
    digest.update(config_home.as_bytes());
    digest.update([0]);
    digest.update(config_path.as_bytes());
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn validate_herdr_context_id(value: &str) -> Result<(), String> {
    if value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err(HERDR_CONTEXT_MISMATCH.into())
    }
}

fn require_matching_herdr_context(
    expected_id: &str,
    actual: &HerdrLocalContext,
) -> Result<(), String> {
    validate_herdr_context_id(expected_id)?;
    if expected_id == actual.id {
        Ok(())
    } else {
        Err(HERDR_CONTEXT_MISMATCH.into())
    }
}

fn herdr_output(
    context: &HerdrLocalContext,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    let mut command = Command::new(&context.executable);
    command.args(args);
    for name in HERDR_TRANSIENT_ENV {
        command.env_remove(name);
    }
    command
        .env(HERDR_CONFIG_HOME_ENV, &context.config_home)
        .env(HERDR_CONFIG_PATH_ENV, &context.config_path)
        .output()
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

fn validate_local_session_owner(owner: &LocalSessionOwner) -> Result<(), String> {
    for value in [
        &owner.run_id,
        &owner.occurrence_id,
        &owner.attempt_id,
        &owner.session_id,
    ] {
        if value.is_empty()
            || value.len() > 512
            || value
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte == 0x7f)
        {
            return Err("Invalid local observation owner identity.".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn new_local_session_id(owner: &LocalSessionOwner, descriptor: &LocalAttachment) -> String {
    let sequence = ATTACH_LAUNCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut digest = Sha256::new();
    for value in [
        owner.run_id.as_str(),
        owner.attempt_id.as_str(),
        owner.session_id.as_str(),
        descriptor.terminal_session_id.as_str(),
        descriptor.pane_id.as_str(),
    ] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    digest.update(std::process::id().to_le_bytes());
    digest.update(nanos.to_le_bytes());
    digest.update(sequence.to_le_bytes());
    format!("local-observation-{:x}", digest.finalize())
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
    xdg_config_home: PathBuf,
    herdr_config_path: PathBuf,
}

#[cfg(target_os = "macos")]
const ATTACH_START_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const ATTACH_DETACH_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "macos")]
const ATTACH_FORCE_TIMEOUT: Duration = Duration::from_secs(1);
#[cfg(target_os = "macos")]
const ATTACH_CLOSE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(7);
#[cfg(target_os = "macos")]
const ATTACH_CONTROL_SOCKET_SUFFIX: &str = ".sock";
#[cfg(target_os = "macos")]
const LOCAL_OBSERVATION_EVENT: &str = "qe://local-observation-state";

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalAttachEnvelope {
    launch: TerminalAttachLaunch,
    session: LocalObservationStatus,
    control_token: String,
    control_socket: PathBuf,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalAttachControl {
    Started {
        local_session_id: String,
        attach_pid: u32,
    },
    Detach {
        local_session_id: String,
        control_token: String,
    },
    Closed {
        local_session_id: String,
        state: String,
        reason: String,
        exit_code: Option<i32>,
        signal: Option<i32>,
        forced: bool,
    },
    Failed {
        local_session_id: String,
        message: String,
    },
}

#[cfg(target_os = "macos")]
struct OpenedTerminalAttachment {
    stream: UnixStream,
}

#[cfg(target_os = "macos")]
enum AttachmentLauncherEvent {
    DetachRequested(TerminalAttachControl),
    TerminalClosed,
    ControlDisconnected,
    ChildExited(std::io::Result<ExitStatus>),
}

#[cfg(target_os = "macos")]
struct AttachmentChildOutcome {
    state: String,
    reason: String,
    exit_code: Option<i32>,
    signal: Option<i32>,
    forced: bool,
}

#[cfg(target_os = "macos")]
struct UnregisteredAttachmentChild(Option<std::process::Child>);

#[cfg(target_os = "macos")]
impl Drop for UnregisteredAttachmentChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
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
    let xdg_config_home = validate_context_path_value(&launch.xdg_config_home, true)?;
    let herdr_config_path = validate_context_path_value(&launch.herdr_config_path, false)?;

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
    let mut environment = vec![
        (
            OsString::from(HERDR_CONFIG_HOME_ENV),
            xdg_config_home.into_os_string(),
        ),
        (
            OsString::from(HERDR_CONFIG_PATH_ENV),
            herdr_config_path.into_os_string(),
        ),
    ];
    if let Some(home) = &launch.home {
        environment.push((OsString::from("HOME"), home.as_os_str().to_owned()));
    }
    Ok(NativeCommandSpec {
        executable: herdr_path,
        args,
        environment,
    })
}

#[cfg(target_os = "macos")]
fn validate_context_path_value(path: &Path, directory: bool) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(HERDR_CONTEXT_UNAVAILABLE.into());
    }
    let canonical = fs::canonicalize(path).map_err(|_| HERDR_CONTEXT_UNAVAILABLE)?;
    let metadata = fs::metadata(&canonical).map_err(|_| HERDR_CONTEXT_UNAVAILABLE)?;
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(HERDR_CONTEXT_UNAVAILABLE.into());
    }
    Ok(canonical)
}

#[cfg(target_os = "macos")]
fn open_terminal_attachment(
    launch: &TerminalAttachLaunch,
    session: &LocalObservationStatus,
) -> Result<OpenedTerminalAttachment, String> {
    let _ = herdr_attach_command(launch)?;
    let directory = create_attachment_launch_directory()?;
    let launcher_path = directory.join(ATTACH_LAUNCHER_NAME);
    let descriptor_path = directory.join("launch.json");
    let control_socket = attachment_control_socket_path(&directory)?;
    let listener = UnixListener::bind(&control_socket)
        .map_err(|_| "Could not create the native session-attach control channel.".to_string())?;
    fs::set_permissions(&control_socket, fs::Permissions::from_mode(0o600))
        .map_err(|_| "Could not secure the native session-attach control channel.".to_string())?;
    let current_executable = std::env::current_exe()
        .map_err(|_| "Could not locate the native session-attach launcher.".to_string())?;
    let control_token = local_attachment_control_token(session);
    let envelope = TerminalAttachEnvelope {
        launch: TerminalAttachLaunch {
            herdr_path: launch.herdr_path.clone(),
            terminal_session_id: launch.terminal_session_id.clone(),
            pane_id: launch.pane_id.clone(),
            interaction_mode: launch.interaction_mode.clone(),
            home: launch.home.clone(),
            xdg_config_home: launch.xdg_config_home.clone(),
            herdr_config_path: launch.herdr_config_path.clone(),
        },
        session: session.clone(),
        control_token,
        control_socket: control_socket.clone(),
    };

    fs::copy(&current_executable, &launcher_path)
        .map_err(|_| "Could not prepare the native session-attach launcher.".to_string())?;
    fs::set_permissions(&launcher_path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Could not secure the native session-attach launcher.".to_string())?;
    write_private_json(&descriptor_path, &envelope)
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

    let stream = match accept_terminal_attachment(listener, &control_socket) {
        Ok(stream) => stream,
        Err(message) => {
            cleanup_attachment_launch_directory(&directory);
            return Err(message);
        }
    };
    stream
        .set_read_timeout(Some(ATTACH_START_TIMEOUT))
        .map_err(|_| "Could not bound the native session-attach acknowledgement.".to_string())?;
    let mut reader =
        BufReader::new(stream.try_clone().map_err(|_| {
            "Could not inspect the native session-attach acknowledgement.".to_string()
        })?);
    let message = read_terminal_attach_control(&mut reader)
        .map_err(|_| "The native session-attach launcher returned invalid status.".to_string())?;
    stream
        .set_read_timeout(None)
        .map_err(|_| "Could not restore the native session-attach control channel.".to_string())?;
    match message {
        TerminalAttachControl::Started {
            local_session_id,
            attach_pid,
        } if local_session_id == session.local_session_id && attach_pid > 0 => {
            Ok(OpenedTerminalAttachment { stream })
        }
        TerminalAttachControl::Failed {
            local_session_id,
            message,
        } if local_session_id == session.local_session_id => {
            cleanup_attachment_launch_directory(&directory);
            Err(message)
        }
        _ => {
            cleanup_attachment_launch_directory(&directory);
            Err("The native session-attach launcher returned mismatched status.".into())
        }
    }
}

#[cfg(target_os = "macos")]
fn local_attachment_control_token(session: &LocalObservationStatus) -> String {
    let mut digest = Sha256::new();
    digest.update(b"qe-local-observation-control-v1");
    digest.update([0]);
    digest.update(session.local_session_id.as_bytes());
    digest.update([0]);
    digest.update(session.terminal_session_id.as_bytes());
    digest.update([0]);
    digest.update(session.pane_id.as_bytes());
    format!("sha256:{:x}", digest.finalize())
}

#[cfg(target_os = "macos")]
fn accept_terminal_attachment(
    listener: UnixListener,
    control_socket: &Path,
) -> Result<UnixStream, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let waiter = thread::spawn(move || {
        let _ = sender.send(listener.accept());
    });
    let accepted = receiver.recv_timeout(ATTACH_START_TIMEOUT);
    if accepted.is_err() {
        let _ = UnixStream::connect(control_socket);
    }
    let _ = waiter.join();
    match accepted {
        Ok(Ok((stream, _))) => Ok(stream),
        Ok(Err(_)) => Err("Could not accept the native session-attach control channel.".into()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("The native session-attach launcher did not start within 10 seconds.".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("The native session-attach launcher did not start.".into())
        }
    }
}

#[cfg(target_os = "macos")]
fn create_attachment_launch_directory() -> Result<PathBuf, String> {
    let root = if let Some(configured) = std::env::var_os("QE_SESSION_ATTACH_ROOT") {
        let root = PathBuf::from(configured);
        if !root.is_absolute() {
            return Err("The native session-attach root must be absolute.".into());
        }
        fs::create_dir_all(&root)
            .map_err(|_| "Could not create the native session-attach root.".to_string())?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not secure the native session-attach root.".to_string())?;
        root
    } else {
        std::env::temp_dir()
    };

    for _ in 0..100 {
        let sequence = ATTACH_LAUNCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = root.join(format!(
            "qe-a-{:x}-{sequence:x}-{nanos:x}",
            std::process::id()
        ));
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
fn attachment_control_socket_path(directory: &Path) -> Result<PathBuf, String> {
    let name = directory
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| value.starts_with("qe-a-"))
        .ok_or_else(|| "The native session-attach control identity is invalid.".to_string())?;
    Ok(PathBuf::from("/tmp").join(format!("{name}{ATTACH_CONTROL_SOCKET_SUFFIX}")))
}

#[cfg(target_os = "macos")]
fn cleanup_attachment_launch_directory(directory: &Path) {
    let _ = fs::remove_file(directory.join("launch.json"));
    if let Ok(control_socket) = attachment_control_socket_path(directory) {
        let _ = fs::remove_file(control_socket);
    }
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
    if !directory.file_name()?.to_str()?.starts_with("qe-a-") {
        return None;
    }
    Some(directory)
}

#[cfg(target_os = "macos")]
fn register_local_observation(
    registry: &LocalObservationRegistry,
    app: &AppHandle,
    status: LocalObservationStatus,
    opened: OpenedTerminalAttachment,
) -> Result<(), String> {
    let read_stream = opened
        .stream
        .try_clone()
        .map_err(|_| "Could not monitor the native observation session.".to_string())?;
    let entry = Arc::new(LocalObservationEntry {
        status: Mutex::new(status.clone()),
        changed: Condvar::new(),
        control: Mutex::new(opened.stream),
    });
    let app = app.clone();
    let monitor_entry = entry.clone();
    let monitor_status = status.clone();
    let monitor = thread::Builder::new()
        .name(format!(
            "local-observation-{}",
            &status.local_session_id[status.local_session_id.len().saturating_sub(12)..]
        ))
        .spawn(move || {
            let mut reader = BufReader::new(read_stream);
            let update = match read_terminal_attach_control(&mut reader) {
                Ok(TerminalAttachControl::Closed {
                    local_session_id,
                    state,
                    reason,
                    ..
                }) if local_session_id == monitor_status.local_session_id
                    && matches!(state.as_str(), "detached" | "unavailable") =>
                {
                    Some((state, Some(reason)))
                }
                Ok(TerminalAttachControl::Failed {
                    local_session_id,
                    message,
                }) if local_session_id == monitor_status.local_session_id => {
                    Some(("unavailable".into(), Some(message)))
                }
                Ok(_) => Some((
                    "unavailable".into(),
                    Some("mismatched_launcher_status".into()),
                )),
                Err(_) => Some((
                    "unavailable".into(),
                    Some("launcher_control_disconnected".into()),
                )),
            };
            if let Some((state, reason)) = update {
                let event = {
                    let mut current = monitor_entry
                        .status
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    current.state = state;
                    current.reason = reason;
                    current.clone()
                };
                monitor_entry.changed.notify_all();
                let _ = app.emit(LOCAL_OBSERVATION_EVENT, &event);
            }
        });
    if monitor.is_err() {
        let request = TerminalAttachControl::Detach {
            local_session_id: status.local_session_id.clone(),
            control_token: local_attachment_control_token(&status),
        };
        if let Ok(mut stream) = entry.control.lock() {
            let _ = write_terminal_attach_control(&mut stream, &request);
        }
        return Err("Could not monitor the native observation session.".into());
    }
    registry
        .sessions
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(status.local_session_id.clone(), entry);
    Ok(())
}

#[cfg(target_os = "macos")]
fn close_local_observation(
    registry: &LocalObservationRegistry,
    requested: &LocalObservationStatus,
) -> Result<LocalObservationStatus, String> {
    let entry = registry
        .sessions
        .lock()
        .map_err(|_| "The local observation registry is unavailable.".to_string())?
        .get(&requested.local_session_id)
        .cloned()
        .ok_or_else(|| "The local observation session is stale or unavailable.".to_string())?;

    let mut current = entry
        .status
        .lock()
        .map_err(|_| "The local observation session is unavailable.".to_string())?;
    if !current.same_attachment(requested) {
        return Err(
            "The local observation close request does not match the owned attachment.".into(),
        );
    }
    if matches!(current.state.as_str(), "detached" | "unavailable") {
        return Ok(current.clone());
    }
    if current.state == "attached" {
        let request = TerminalAttachControl::Detach {
            local_session_id: current.local_session_id.clone(),
            control_token: local_attachment_control_token(&current),
        };
        current.state = "detaching".into();
        current.reason = Some("explicit_close_requested".into());
        let write_result = entry
            .control
            .lock()
            .map_err(|_| "The native observation control channel is unavailable.".to_string())
            .and_then(|mut stream| {
                write_terminal_attach_control(&mut stream, &request)
                    .map_err(|_| "Could not request native observation detachment.".to_string())
            });
        if write_result.is_err() {
            current.state = "unavailable".into();
            current.reason = Some("launcher_control_disconnected".into());
            entry.changed.notify_all();
            return Ok(current.clone());
        }
    }

    let deadline = Instant::now() + ATTACH_CLOSE_RESPONSE_TIMEOUT;
    while current.state == "detaching" {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            current.state = "unavailable".into();
            current.reason = Some("detach_ack_timeout".into());
            entry.changed.notify_all();
            return Ok(current.clone());
        }
        let (next, timeout) = entry
            .changed
            .wait_timeout(current, remaining)
            .map_err(|_| "The local observation session is unavailable.".to_string())?;
        current = next;
        if timeout.timed_out() && current.state == "detaching" {
            current.state = "unavailable".into();
            current.reason = Some("detach_ack_timeout".into());
            entry.changed.notify_all();
            return Ok(current.clone());
        }
    }
    Ok(current.clone())
}

#[cfg(target_os = "macos")]
fn read_terminal_attach_control(
    reader: &mut impl BufRead,
) -> std::io::Result<TerminalAttachControl> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "attachment control channel closed",
        ));
    }
    serde_json::from_str(&line)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

#[cfg(target_os = "macos")]
fn write_terminal_attach_control(
    stream: &mut UnixStream,
    message: &TerminalAttachControl,
) -> std::io::Result<()> {
    serde_json::to_writer(&mut *stream, message)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

#[cfg(target_os = "macos")]
fn signal_attachment_child(pid: u32, signal: i32) -> std::io::Result<()> {
    let result = unsafe { libc::kill(pid as libc::pid_t, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn run_terminal_attachment_launcher(directory: &Path) -> i32 {
    let descriptor_path = directory.join("launch.json");
    let result = (|| -> Result<i32, String> {
        let bytes = fs::read(&descriptor_path)
            .map_err(|_| "The native session-attach descriptor is unavailable.".to_string())?;
        let envelope: TerminalAttachEnvelope = serde_json::from_slice(&bytes)
            .map_err(|_| "The native session-attach descriptor is invalid.".to_string())?;
        if envelope.control_socket != attachment_control_socket_path(directory)? {
            return Err("The native session-attach control identity is invalid.".into());
        }
        let command = herdr_attach_command(&envelope.launch)?;
        let _ = fs::remove_file(&descriptor_path);
        let mut stream = UnixStream::connect(&envelope.control_socket).map_err(|_| {
            "Could not connect the native session-attach control channel.".to_string()
        })?;

        let (sender, receiver) = mpsc::channel();
        let signal_sender = sender.clone();
        ctrlc::set_handler(move || {
            let _ = signal_sender.send(AttachmentLauncherEvent::TerminalClosed);
        })
        .map_err(|_| "Could not monitor native terminal closure.".to_string())?;
        let control_stream = stream
            .try_clone()
            .map_err(|_| "Could not monitor native detach requests.".to_string())?;

        let mut process = Command::new(&command.executable);
        process.args(&command.args);
        for name in HERDR_TRANSIENT_ENV {
            process.env_remove(name);
        }
        for (name, value) in &command.environment {
            process.env(name, value);
        }
        let mut unregistered_child = UnregisteredAttachmentChild(Some(
            process
                .spawn()
                .map_err(|_| "Could not start the pinned Herdr attachment.".to_string())?,
        ));
        let child = unregistered_child.0.as_mut().expect("attachment child");
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Could not inspect the pinned Herdr attachment.".to_string())?
        {
            return Err(format!(
                "The pinned Herdr attachment exited before becoming observable ({status})."
            ));
        }
        write_terminal_attach_control(
            &mut stream,
            &TerminalAttachControl::Started {
                local_session_id: envelope.session.local_session_id.clone(),
                attach_pid: child.id(),
            },
        )
        .map_err(|_| "Could not acknowledge the native Herdr attachment.".to_string())?;

        let control_sender = sender.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(control_stream);
            let event = match read_terminal_attach_control(&mut reader) {
                Ok(message) => AttachmentLauncherEvent::DetachRequested(message),
                Err(_) => AttachmentLauncherEvent::ControlDisconnected,
            };
            let _ = control_sender.send(event);
        });
        let child_sender = sender;
        let child = unregistered_child.0.take().expect("attachment child");
        let pid = child.id();
        let (lifecycle_sender, lifecycle_receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut child = child;
            let _ = child_sender.send(AttachmentLauncherEvent::ChildExited(child.wait()));
        });
        thread::spawn(move || {
            while let Ok(event) = receiver.recv() {
                if lifecycle_sender.send(event).is_err() {
                    break;
                }
            }
        });

        let outcome = run_attachment_pid_lifecycle(
            pid,
            lifecycle_receiver,
            &envelope.session.local_session_id,
            &envelope.control_token,
            ATTACH_DETACH_TIMEOUT,
            ATTACH_FORCE_TIMEOUT,
        );
        write_terminal_attach_control(
            &mut stream,
            &TerminalAttachControl::Closed {
                local_session_id: envelope.session.local_session_id,
                state: outcome.state.clone(),
                reason: outcome.reason,
                exit_code: outcome.exit_code,
                signal: outcome.signal,
                forced: outcome.forced,
            },
        )
        .map_err(|_| "Could not acknowledge native observation closure.".to_string())?;
        Ok(if outcome.state == "detached" { 0 } else { 1 })
    })();

    let code = match result {
        Ok(code) => code,
        Err(message) => {
            if let Ok(control_socket) = attachment_control_socket_path(directory) {
                if let Ok(mut stream) = UnixStream::connect(control_socket) {
                    let local_session_id = fs::read(&descriptor_path)
                        .ok()
                        .and_then(|bytes| {
                            serde_json::from_slice::<TerminalAttachEnvelope>(&bytes).ok()
                        })
                        .map(|envelope| envelope.session.local_session_id)
                        .unwrap_or_default();
                    let _ = write_terminal_attach_control(
                        &mut stream,
                        &TerminalAttachControl::Failed {
                            local_session_id,
                            message,
                        },
                    );
                }
            }
            1
        }
    };
    cleanup_attachment_launch_directory(directory);
    code
}

#[cfg(target_os = "macos")]
fn request_attachment_child_exit(
    pid: u32,
    deadline: &mut Option<Instant>,
    timeout: Duration,
) -> Result<(), AttachmentChildOutcome> {
    if deadline.is_some() {
        return Ok(());
    }
    *deadline = Some(Instant::now() + timeout);
    match signal_attachment_child(pid, libc::SIGTERM) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        Err(_) => Err(AttachmentChildOutcome {
            state: "unavailable".into(),
            reason: "attach_client_signal_failed".into(),
            exit_code: None,
            signal: None,
            forced: false,
        }),
    }
}

#[cfg(target_os = "macos")]
fn wait_for_forced_attachment_exit(
    receiver: &mpsc::Receiver<AttachmentLauncherEvent>,
    timeout: Duration,
) -> AttachmentChildOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(AttachmentLauncherEvent::ChildExited(Ok(status))) => {
                return AttachmentChildOutcome {
                    state: "unavailable".into(),
                    reason: "attach_client_term_timeout".into(),
                    exit_code: status.code(),
                    signal: status.signal(),
                    forced: true,
                };
            }
            Ok(_) => continue,
            Err(_) => {
                return AttachmentChildOutcome {
                    state: "unavailable".into(),
                    reason: "attach_client_unreaped".into(),
                    exit_code: None,
                    signal: None,
                    forced: true,
                };
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn run_attachment_pid_lifecycle(
    pid: u32,
    receiver: mpsc::Receiver<AttachmentLauncherEvent>,
    local_session_id: &str,
    control_token: &str,
    detach_timeout: Duration,
    force_timeout: Duration,
) -> AttachmentChildOutcome {
    let mut reason = "attach_client_exited".to_string();
    let mut deadline: Option<Instant> = None;
    loop {
        let event = if let Some(until) = deadline {
            match receiver.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    match signal_attachment_child(pid, libc::SIGKILL) {
                        Ok(()) => {}
                        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
                        Err(_) => {
                            return AttachmentChildOutcome {
                                state: "unavailable".into(),
                                reason: "attach_client_force_signal_failed".into(),
                                exit_code: None,
                                signal: None,
                                forced: false,
                            };
                        }
                    }
                    return wait_for_forced_attachment_exit(&receiver, force_timeout);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return AttachmentChildOutcome {
                        state: "unavailable".into(),
                        reason: "attach_client_wait_failed".into(),
                        exit_code: None,
                        signal: None,
                        forced: false,
                    };
                }
            }
        } else {
            match receiver.recv() {
                Ok(event) => event,
                Err(_) => AttachmentLauncherEvent::ControlDisconnected,
            }
        };

        match event {
            AttachmentLauncherEvent::DetachRequested(TerminalAttachControl::Detach {
                local_session_id: requested_id,
                control_token: requested_token,
            }) if requested_id == local_session_id && requested_token == control_token => {
                reason = "explicit_close".into();
                if let Err(outcome) =
                    request_attachment_child_exit(pid, &mut deadline, detach_timeout)
                {
                    return outcome;
                }
            }
            AttachmentLauncherEvent::TerminalClosed => {
                reason = "terminal_closed".into();
                if let Err(outcome) =
                    request_attachment_child_exit(pid, &mut deadline, detach_timeout)
                {
                    return outcome;
                }
            }
            AttachmentLauncherEvent::ControlDisconnected => {
                reason = "native_client_disconnected".into();
                if let Err(outcome) =
                    request_attachment_child_exit(pid, &mut deadline, detach_timeout)
                {
                    return outcome;
                }
            }
            AttachmentLauncherEvent::ChildExited(result) => {
                return match result {
                    Ok(status)
                        if status.success()
                            && matches!(reason.as_str(), "explicit_close" | "terminal_closed") =>
                    {
                        AttachmentChildOutcome {
                            state: "detached".into(),
                            reason,
                            exit_code: status.code(),
                            signal: status.signal(),
                            forced: false,
                        }
                    }
                    Ok(status) => AttachmentChildOutcome {
                        state: "unavailable".into(),
                        reason: "attach_client_exited_unexpectedly".into(),
                        exit_code: status.code(),
                        signal: status.signal(),
                        forced: false,
                    },
                    Err(_) => AttachmentChildOutcome {
                        state: "unavailable".into(),
                        reason: "attach_client_wait_failed".into(),
                        exit_code: None,
                        signal: None,
                        forced: false,
                    },
                };
            }
            AttachmentLauncherEvent::DetachRequested(_) => {}
        }
    }
}

#[tauri::command]
fn notification_action_types_supported() -> bool {
    // Plugin 2.3.3 exposes action-type registration on mobile only; ordinary
    // desktop notifications remain supported without registering actions.
    cfg!(any(target_os = "android", target_os = "ios"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_action_types_match_the_compiled_target() {
        assert_eq!(
            notification_action_types_supported(),
            cfg!(any(target_os = "android", target_os = "ios"))
        );
    }

    #[cfg(unix)]
    fn write_test_executable(path: &Path, body: &str, mode: u32) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "helper invoked by native observation lifecycle tests"]
    fn attachment_signal_test_child() {
        if std::env::var_os("QE_NATIVE_ATTACHMENT_SIGNAL_CHILD").is_none() {
            return;
        }
        ctrlc::set_handler(|| std::process::exit(0)).unwrap();
        println!("QE_ATTACHMENT_CHILD_READY");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }

    #[cfg(target_os = "macos")]
    fn spawn_attachment_signal_test_child() -> std::process::Child {
        use std::process::Stdio;

        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::attachment_signal_test_child",
                "--ignored",
                "--nocapture",
            ])
            .env("QE_NATIVE_ATTACHMENT_SIGNAL_CHILD", "1")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line.contains("QE_ATTACHMENT_CHILD_READY") {
                break;
            }
        }
        child
    }

    #[cfg(target_os = "macos")]
    fn run_test_attachment_lifecycle(
        child: std::process::Child,
        requests: Vec<AttachmentLauncherEvent>,
    ) -> AttachmentChildOutcome {
        let pid = child.id();
        let (sender, receiver) = mpsc::channel();
        let child_sender = sender.clone();
        thread::spawn(move || {
            let mut child = child;
            let _ = child_sender.send(AttachmentLauncherEvent::ChildExited(child.wait()));
        });
        for request in requests {
            sender.send(request).unwrap();
        }
        run_attachment_pid_lifecycle(
            pid,
            receiver,
            "local-observation-test",
            "control-test",
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
    }

    #[cfg(target_os = "macos")]
    fn detach_request(id: &str, token: &str) -> AttachmentLauncherEvent {
        AttachmentLauncherEvent::DetachRequested(TerminalAttachControl::Detach {
            local_session_id: id.into(),
            control_token: token.into(),
        })
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn explicit_observation_detach_terms_only_the_owned_attach_child() {
        let mut pane = spawn_attachment_signal_test_child();
        let attach = spawn_attachment_signal_test_child();
        let outcome = run_test_attachment_lifecycle(
            attach,
            vec![detach_request("local-observation-test", "control-test")],
        );

        assert_eq!(outcome.state, "detached");
        assert_eq!(outcome.reason, "explicit_close");
        assert!(!outcome.forced);
        assert!(
            pane.try_wait().unwrap().is_none(),
            "Herdr pane was signalled"
        );
        pane.kill().unwrap();
        pane.wait().unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_close_reconciles_as_normal_detach() {
        let attach = spawn_attachment_signal_test_child();
        let outcome =
            run_test_attachment_lifecycle(attach, vec![AttachmentLauncherEvent::TerminalClosed]);

        assert_eq!(outcome.state, "detached");
        assert_eq!(outcome.reason, "terminal_closed");
        assert!(!outcome.forced);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn repeated_detach_is_one_bounded_owned_child_lifecycle() {
        let attach = spawn_attachment_signal_test_child();
        let outcome = run_test_attachment_lifecycle(
            attach,
            vec![
                detach_request("local-observation-test", "control-test"),
                detach_request("local-observation-test", "control-test"),
            ],
        );

        assert_eq!(outcome.state, "detached");
        assert_eq!(outcome.reason, "explicit_close");
        assert!(!outcome.forced);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stale_detach_cannot_target_the_current_observer() {
        let attach = spawn_attachment_signal_test_child();
        let outcome = run_test_attachment_lifecycle(
            attach,
            vec![
                detach_request("stale-observation", "stale-control"),
                detach_request("local-observation-test", "control-test"),
            ],
        );

        assert_eq!(outcome.state, "detached");
        assert_eq!(outcome.reason, "explicit_close");
        assert!(!outcome.forced);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unexpected_attach_child_exit_is_truthfully_unavailable() {
        let status = Command::new("/usr/bin/false").status().unwrap();
        let (sender, receiver) = mpsc::channel();
        sender
            .send(AttachmentLauncherEvent::ChildExited(Ok(status)))
            .unwrap();
        let outcome = run_attachment_pid_lifecycle(
            u32::MAX,
            receiver,
            "local-observation-test",
            "control-test",
            Duration::from_secs(1),
            Duration::from_secs(1),
        );

        assert_eq!(outcome.state, "unavailable");
        assert_eq!(outcome.reason, "attach_client_exited_unexpectedly");
        assert!(!outcome.forced);
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

    #[cfg(unix)]
    fn run_context_subprocess(
        mode: &str,
        executable: &Path,
        config_home: &Path,
        config_path: &Path,
        expected_config_home: &Path,
        expected_config_path: &Path,
        home: &Path,
        expected_id: &str,
        marker: &Path,
    ) {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::herdr_context_subprocess",
                "--ignored",
                "--nocapture",
            ])
            .env("QE_NATIVE_HERDR_CONTEXT_TEST_MODE", mode)
            .env(HERDR_BIN_ENV, executable)
            .env(HERDR_CONFIG_HOME_ENV, config_home)
            .env(HERDR_CONFIG_PATH_ENV, config_path)
            .env("QE_HERDR_TEST_EXPECTED_CONFIG_HOME", expected_config_home)
            .env("QE_HERDR_TEST_EXPECTED_CONFIG_PATH", expected_config_path)
            .env("HOME", home)
            .env("QE_HERDR_TEST_EXPECTED_CONTEXT_ID", expected_id)
            .env("QE_HERDR_TEST_CONTEXT_MARKER", marker)
            .status()
            .unwrap();
        assert!(status.success(), "context subprocess failed for {mode}");
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "helper invoked by differing_home_uses_one_context_and_split_root_fails_closed"]
    fn herdr_context_subprocess() {
        let Ok(mode) = std::env::var("QE_NATIVE_HERDR_CONTEXT_TEST_MODE") else {
            return;
        };
        let context = resolve_herdr_local_context().unwrap();
        let expected = std::env::var("QE_HERDR_TEST_EXPECTED_CONTEXT_ID").unwrap();
        if mode == "split" {
            assert_eq!(
                require_matching_herdr_context(&expected, &context).unwrap_err(),
                HERDR_CONTEXT_MISMATCH
            );
            return;
        }
        assert_eq!(mode, "shared");
        require_matching_herdr_context(&expected, &context).unwrap();
        let sessions = herdr_output(&context, &["session", "list", "--json"]).unwrap();
        assert!(sessions.status.success());
        assert_eq!(
            session_is_running(&sessions.stdout, "worker-session"),
            Ok(true)
        );
        let agent = herdr_output(
            &context,
            &["--session", "worker-session", "agent", "get", "w2:p2"],
        )
        .unwrap();
        assert!(agent.status.success());
        let agent: serde_json::Value = serde_json::from_slice(&agent.stdout).unwrap();
        assert!(json_contains_field(&agent, &["qe_worker_id"], "worker-a"));
        assert!(json_contains_field(&agent, &["qe_lineage_id"], "lineage-a"));
    }

    #[cfg(unix)]
    #[test]
    fn differing_home_uses_one_context_and_split_root_fails_closed() {
        let root = resolver_test_directory();
        let executable = root.join("herdr");
        let shared_config_home = root.join("shared-config-home");
        let split_config_home = root.join("split-config-home");
        let config_path = root.join("config.toml");
        let worker_home = root.join("worker-home");
        let desktop_home = root.join("desktop-home");
        let marker = root.join("invocations");
        for directory in [
            &shared_config_home,
            &split_config_home,
            &worker_home,
            &desktop_home,
        ] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(&config_path, "theme = \"default\"\n").unwrap();
        write_test_executable(
            &executable,
            r#"#!/bin/sh
if [ "$XDG_CONFIG_HOME" != "$QE_HERDR_TEST_EXPECTED_CONFIG_HOME" ] || [ "$HERDR_CONFIG_PATH" != "$QE_HERDR_TEST_EXPECTED_CONFIG_PATH" ]; then
  exit 91
fi
printf '%s|%s|%s|%s\n' "$HOME" "$XDG_CONFIG_HOME" "$HERDR_CONFIG_PATH" "$*" >> "$QE_HERDR_TEST_CONTEXT_MARKER"
case "$*" in
  "session list --json") printf '%s\n' '{"sessions":[{"name":"worker-session","running":true}]}' ;;
  "--session worker-session agent get w2:p2") printf '%s\n' '{"result":{"agent":{"qe_owner":"quest-engineering-worker/v1","qe_worker_id":"worker-a","qe_lineage_id":"lineage-a","terminal_id":"terminal-a","status":"idle"}}}' ;;
  *) exit 92 ;;
esac
"#,
            0o755,
        );
        let canonical_executable = std::fs::canonicalize(&executable).unwrap();
        let canonical_home = std::fs::canonicalize(&shared_config_home).unwrap();
        let canonical_config = std::fs::canonicalize(&config_path).unwrap();
        let expected_id =
            herdr_local_context_id(&canonical_executable, &canonical_home, &canonical_config)
                .unwrap();

        let worker = Command::new(&canonical_executable)
            .args(["session", "list", "--json"])
            .env("HOME", &worker_home)
            .env(HERDR_CONFIG_HOME_ENV, &canonical_home)
            .env(HERDR_CONFIG_PATH_ENV, &canonical_config)
            .env("QE_HERDR_TEST_EXPECTED_CONFIG_HOME", &canonical_home)
            .env("QE_HERDR_TEST_EXPECTED_CONFIG_PATH", &canonical_config)
            .env("QE_HERDR_TEST_CONTEXT_MARKER", &marker)
            .output()
            .unwrap();
        assert!(worker.status.success());
        assert_eq!(
            session_is_running(&worker.stdout, "worker-session"),
            Ok(true)
        );

        run_context_subprocess(
            "shared",
            &canonical_executable,
            &canonical_home,
            &canonical_config,
            &canonical_home,
            &canonical_config,
            &desktop_home,
            &expected_id,
            &marker,
        );
        let before_split = std::fs::read_to_string(&marker).unwrap();
        run_context_subprocess(
            "split",
            &canonical_executable,
            &split_config_home,
            &canonical_config,
            &canonical_home,
            &canonical_config,
            &desktop_home,
            &expected_id,
            &marker,
        );

        let invocations = std::fs::read_to_string(&marker).unwrap();
        assert_eq!(invocations, before_split, "split context invoked Herdr");
        assert!(invocations.contains(worker_home.to_str().unwrap()));
        assert!(invocations.contains(desktop_home.to_str().unwrap()));
        assert!(invocations.contains(canonical_home.to_str().unwrap()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn herdr_context_digest_matches_worker_vector() {
        assert_eq!(
            herdr_local_context_id(
                Path::new("/opt/qe/herdr"),
                Path::new("/var/run/qe-herdr"),
                Path::new("/etc/qe/herdr.toml"),
            )
            .unwrap(),
            "sha256:2baa25a6a46e4124aba866c27b9cb716748cb7d3b0ec9fad01c00a7e259dd2d0"
        );
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
        let root = resolver_test_directory();
        let config_home = root.join("config-home");
        let config_path = root.join("config.toml");
        std::fs::create_dir(&config_home).unwrap();
        std::fs::write(&config_path, "theme = \"default\"\n").unwrap();
        let mut launch = TerminalAttachLaunch {
            herdr_path: executable.clone(),
            terminal_session_id: "worker-session".into(),
            pane_id: "w12:p7".into(),
            interaction_mode: "observe".into(),
            home: Some(PathBuf::from("/control/home")),
            xdg_config_home: config_home.clone(),
            herdr_config_path: config_path.clone(),
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
        assert!(observe.environment.contains(&(
            OsString::from(HERDR_CONFIG_HOME_ENV),
            std::fs::canonicalize(config_home).unwrap().into_os_string(),
        )));
        assert!(observe.environment.contains(&(
            OsString::from(HERDR_CONFIG_PATH_ENV),
            std::fs::canonicalize(config_path).unwrap().into_os_string(),
        )));
        std::fs::remove_dir_all(root).unwrap();
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
        .manage(LocalObservationRegistry::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            open_live_session,
            close_live_session,
            notification_action_types_supported
        ])
        .run(tauri::generate_context!())
        .expect("error while running Quest Engineering client");
}
