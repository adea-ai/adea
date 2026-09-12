// shell-bench Tauri parity shell (baseline). Minimal window loading whatever
// URL is passed as --url=..., plus a ping command for the IPC probe. Nothing else.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::WebviewUrl;

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

fn main() {
    let url = std::env::args()
        .find(|a| a.starts_with("--url="))
        .map(|a| a[6..].to_string());

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
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
