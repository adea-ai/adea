#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod boot;
mod cloud;
#[cfg(test)]
mod ipc_contract;
mod local_content;
mod preferences;
mod transcription;
mod updater;

fn main() {
    let diagnostics = boot::BootDiagnostics::from_process();
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        let handoff_diagnostics = diagnostics.clone();
        builder = builder.plugin(tauri_plugin_single_instance::init(
            move |app, arguments, _| {
                // The forwarding process is terminated by the plugin before it can
                // write its own exit, so the receiver records the handoff.
                handoff_diagnostics.record_handoff();
                for argument in arguments {
                    auth::receive_auth_callback(app, &argument);
                }
            },
        ));
    }

    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(auth::DesktopAuthState::default())
        .manage(transcription::DesktopTranscriptionState::default())
        .manage(updater::UpdaterState::default())
        .manage(diagnostics.clone())
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
        .setup(boot::install);

    std::process::exit(boot::launch(builder, diagnostics));
}
