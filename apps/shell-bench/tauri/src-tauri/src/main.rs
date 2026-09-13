// shell-bench Tauri parity shell (baseline). Loads --url=... and implements the
// desktop command surface with file-backed state so the unmodified client can
// boot authenticated. Disposable — deleted by #371.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::WebviewUrl;

fn state_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join("Library/Application Support/shell-bench-tauri/bench-state")
}

fn trace(cmd: &str) {
    let _ = fs::write(format!("/tmp/tauri-shim-{}.log", cmd), "invoked");
}

fn read_state(name: &str) -> Option<Value> {
    let text = fs::read_to_string(state_dir().join(name)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_state(name: &str, value: &Value) {
    let dir = state_dir();
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(dir.join(name), serde_json::to_string(value).unwrap_or_default());
}

fn clear_state(name: &str) {
    let _ = fs::remove_file(state_dir().join(name));
}

fn read_text(name: &str) -> Option<String> {
    fs::read_to_string(state_dir().join(name))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn write_text(name: &str, value: &str) {
    let dir = state_dir();
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(dir.join(name), value);
}

#[tauri::command]
fn ping() -> &'static str {
    trace("ping");
    "pong"
}

#[tauri::command]
fn desktop_user_session_load() -> Option<Value> {
    trace("desktop_user_session_load");
    read_state("session.json")
}

#[tauri::command]
fn desktop_user_session_save(session: Value) {
    write_state("session.json", &session);
}

#[tauri::command]
fn desktop_user_session_clear() {
    clear_state("session.json");
}

#[tauri::command]
fn desktop_auth_attempt_load() -> Option<Value> {
    trace("desktop_auth_attempt_load");
    read_state("auth-attempt.json")
}

#[tauri::command]
fn desktop_auth_attempt_save(attempt: Value) {
    write_state("auth-attempt.json", &attempt);
}

#[tauri::command]
fn desktop_auth_attempt_clear() {
    clear_state("auth-attempt.json");
}

#[tauri::command]
fn desktop_auth_start(authorization_url: String) {
    write_text("auth-url.txt", &authorization_url);
}

#[tauri::command]
fn desktop_auth_take_callback() -> Option<String> {
    trace("desktop_auth_take_callback");
    let callback = read_text("callback.txt");
    if callback.is_some() {
        clear_state("callback.txt");
    }
    callback
}

#[tauri::command]
fn desktop_temporary_workspace_load() -> Option<String> {
    read_text("temporary-workspace.txt")
}

#[tauri::command]
fn desktop_temporary_workspace_save(credential: String) {
    write_text("temporary-workspace.txt", &credential);
}

#[tauri::command]
fn desktop_temporary_workspace_clear() {
    clear_state("temporary-workspace.txt");
}

#[tauri::command]
fn desktop_preferences_load() -> Option<Value> {
    read_state("preferences.json")
}

#[tauri::command]
fn desktop_preferences_save(preferences: Value) {
    write_state("preferences.json", &preferences);
}

#[tauri::command]
fn local_content_authorize_workspace(_workspace_id: String) {}

#[tauri::command]
fn local_content_create() -> Option<Value> { None }
#[tauri::command]
fn local_content_read() -> Option<Value> { None }
#[tauri::command]
fn local_content_update() -> Option<Value> { None }
#[tauri::command]
fn local_content_delete() {}
#[tauri::command]
fn local_content_search() -> Vec<Value> { vec![] }
#[tauri::command]
fn local_content_health() -> Value { serde_json::json!({ "ok": true }) }
#[tauri::command]
fn local_content_rotate_key() {}

#[tauri::command]
fn desktop_update_check() -> Value { serde_json::json!({ "upToDate": true }) }
#[tauri::command]
fn desktop_update_status() -> Value { serde_json::json!({ "upToDate": true }) }
#[tauri::command]
fn desktop_update_install() {}

#[tauri::command]
fn desktop_transcription_permission() -> &'static str { "denied" }
#[tauri::command]
fn desktop_transcription_start() -> Result<(), String> { Err("unavailable in bench shell".into()) }
#[tauri::command]
fn desktop_transcription_cancel() {}

fn main() {
    let url = std::env::args()
        .find(|a| a.starts_with("--url="))
        .map(|a| a[6..].to_string());

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ping,
            desktop_user_session_load,
            desktop_user_session_save,
            desktop_user_session_clear,
            desktop_auth_attempt_load,
            desktop_auth_attempt_save,
            desktop_auth_attempt_clear,
            desktop_auth_start,
            desktop_auth_take_callback,
            desktop_temporary_workspace_load,
            desktop_temporary_workspace_save,
            desktop_temporary_workspace_clear,
            desktop_preferences_load,
            desktop_preferences_save,
            local_content_authorize_workspace,
            local_content_create,
            local_content_read,
            local_content_update,
            local_content_delete,
            local_content_search,
            local_content_health,
            local_content_rotate_key,
            desktop_update_check,
            desktop_update_status,
            desktop_update_install,
            desktop_transcription_permission,
            desktop_transcription_start,
            desktop_transcription_cancel,
        ])
        .setup(move |app| {
            let url = match url {
                Some(u) => WebviewUrl::External(u.parse().expect("valid bench url")),
                None => WebviewUrl::App("index.html".into()),
            };
            tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("shell-bench-tauri")
                .inner_size(1280.0, 800.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running shell-bench-tauri");
}
