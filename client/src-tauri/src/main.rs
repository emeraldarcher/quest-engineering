#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAttachment {
    mode: String,
    backend_kind: String,
    terminal_session_id: String,
    terminal_target_id: String,
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
    let interactive = interaction_mode == "takeover" || interaction_mode == "recovery";
    if interaction_mode == "takeover" && !descriptor.takeover_allowed {
        return Err("Interactive takeover is not allowed for this session state.".into());
    }
    if interaction_mode == "recovery" && !descriptor.recovery_allowed {
        return Err("Interactive recovery is not allowed for this session state.".into());
    }
    if !matches!(interaction_mode.as_str(), "observe" | "takeover" | "recovery") {
        return Err("Unsupported live-session interaction mode.".into());
    }
    validate_session_name(&descriptor.terminal_session_id)?;
    validate_agent_name(&descriptor.terminal_target_id)?;

    let herdr = find_herdr()?;
    let sessions = Command::new(&herdr)
        .args(["session", "list", "--json"])
        .output()
        .map_err(|_| "Could not inspect local Herdr sessions.".to_string())?;
    if !sessions.status.success()
        || !session_is_running(&sessions.stdout, &descriptor.terminal_session_id)
    {
        return Err("The referenced Worker session is not running on this host.".into());
    }

    let output = Command::new(&herdr)
        .args([
            "--session",
            &descriptor.terminal_session_id,
            "agent",
            "get",
            &descriptor.terminal_target_id,
        ])
        .output()
        .map_err(|_| "Could not inspect the local Herdr session.".to_string())?;
    if !output.status.success() {
        return Err("The referenced Worker session is not available on this host.".into());
    }
    let agent: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Herdr returned an invalid session inspection.".to_string())?;
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
        let mut command = format!(
            "exec {} --session {} agent attach {}",
            shell_quote(herdr.to_string_lossy().as_ref()),
            shell_quote(&descriptor.terminal_session_id),
            shell_quote(&descriptor.terminal_target_id)
        );
        if interactive {
            command.push_str(" --takeover");
        }
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script {}\nend tell",
            apple_script_string(&command)
        );
        let status = Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .status()
            .map_err(|_| "Could not open the local terminal application.".to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err("The terminal application rejected the attach request.".into());
    }

    #[cfg(not(target_os = "macos"))]
    Err("Native Herdr attachment is currently implemented for macOS only.".into())
}

fn find_herdr() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join("herdr");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    for candidate in ["/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("Herdr is not installed or is unavailable to Quest Engineering.".into())
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

fn session_is_running(bytes: &[u8], expected: &str) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return false;
    };
    value
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .map(|sessions| {
            sessions.iter().any(|session| {
                session.get("name").and_then(serde_json::Value::as_str) == Some(expected)
                    && session.get("running").and_then(serde_json::Value::as_bool) == Some(true)
            })
        })
        .unwrap_or(false)
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn apple_script_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('\"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_scoped_herdr_identifiers() {
        assert!(validate_session_name("quest-engineering-worker").is_ok());
        assert!(validate_agent_name("qe-1234-review").is_ok());
        assert!(validate_session_name("bad; command").is_err());
        assert!(validate_agent_name("Bad Agent").is_err());
    }

    #[test]
    fn requires_an_existing_running_named_session() {
        let body = br#"{"sessions":[{"name":"worker-a","running":true},{"name":"worker-b","running":false}]}"#;
        assert!(session_is_running(body, "worker-a"));
        assert!(!session_is_running(body, "worker-b"));
        assert!(!session_is_running(body, "worker-c"));
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![open_live_session])
        .run(tauri::generate_context!())
        .expect("error while running Quest Engineering client");
}
