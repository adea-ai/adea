#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn web_app_url() -> String {
    std::env::var("AGENT_HQ_WEB_URL").unwrap_or_else(|_| "http://localhost:3004".to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bridge::native_capabilities])
        .setup(|app| {
            let url = web_app_url().parse().expect("AGENT_HQ_WEB_URL must be a valid URL");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Agent HQ")
                .inner_size(1440.0, 960.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Agent HQ desktop shell");
}
