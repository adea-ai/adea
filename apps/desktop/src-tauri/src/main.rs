#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod updater;

use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEV_WEB_URL: &str = "http://127.0.0.1:3004";
const PRODUCTION_WEB_URL: &str = "https://agent-hq-site.vercel.app";

fn web_app_url() -> String {
    if let Ok(value) = std::env::var("AGENT_HQ_WEB_URL") {
        return value;
    }

    if cfg!(debug_assertions) {
        DEV_WEB_URL.to_string()
    } else {
        PRODUCTION_WEB_URL.to_string()
    }
}

fn main() {
    tauri::Builder::default()
        .manage(updater::UpdaterState::default())
        .invoke_handler(tauri::generate_handler![
            bridge::native_capabilities,
            updater::desktop_update_status,
            updater::desktop_update_check,
            updater::desktop_update_install
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let url = web_app_url()
                .parse()
                .expect("AGENT_HQ_WEB_URL must be a valid URL");
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
