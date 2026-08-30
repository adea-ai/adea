#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod bridge;
mod local_content;
mod preferences;
mod transcription;
mod updater;

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.show();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn receive_auth_callback<R: Runtime>(app: &AppHandle<R>, raw_url: &str) {
    if auth::queue_callback(app, raw_url) {
        reveal_main_window(app);
    }
}

fn main() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, arguments, _| {
            for argument in arguments {
                receive_auth_callback(app, &argument);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(auth::DesktopAuthState::default())
        .manage(transcription::DesktopTranscriptionState::default())
        .manage(updater::UpdaterState::default())
        .invoke_handler(tauri::generate_handler![
            auth::desktop_auth_start,
            auth::desktop_auth_take_callback,
            auth::desktop_auth_attempt_clear,
            auth::desktop_auth_attempt_load,
            auth::desktop_auth_attempt_save,
            auth::desktop_user_session_clear,
            auth::desktop_user_session_load,
            auth::desktop_user_session_save,
            auth::desktop_temporary_workspace_clear,
            auth::desktop_temporary_workspace_load,
            auth::desktop_temporary_workspace_save,
            bridge::native_capabilities,
            local_content::local_content_authorize_workspace,
            local_content::local_content_create,
            local_content::local_content_delete,
            local_content::local_content_health,
            local_content::local_content_read,
            local_content::local_content_rotate_key,
            local_content::local_content_search,
            local_content::local_content_update,
            preferences::desktop_preferences_load,
            preferences::desktop_preferences_save,
            transcription::desktop_transcription_cancel,
            transcription::desktop_transcription_permission,
            transcription::desktop_transcription_start,
            updater::desktop_update_status,
            updater::desktop_update_check,
            updater::desktop_update_install
        ])
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let local_content = local_content::LocalContentState::initialize(&app_data_dir);
            app.manage(local_content);

            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;

            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    auth::queue_callback(app.handle(), url.as_str());
                }
            }

            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    receive_auth_callback(&app_handle, url.as_str());
                }
            });

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Agent HQ")
                .inner_size(1440.0, 960.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Agent HQ desktop shell");
}
