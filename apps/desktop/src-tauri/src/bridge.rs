#[tauri::command]
pub fn native_capabilities() -> Vec<&'static str> {
    vec![
        "local-harness-discovery",
        "acp-connectivity",
        "filesystem",
        "process-management",
        "secure-credential-storage",
        "deep-links",
        "notifications",
        "auto-update",
    ]
}
