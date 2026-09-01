use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

const PREFERENCES_FILE: &str = "workspace-preferences.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePreferences {
    dictation_locale: String,
    notify_mentions: bool,
    notify_tasks: bool,
    private_notification_previews: bool,
    version: u8,
}

impl Default for WorkspacePreferences {
    fn default() -> Self {
        Self {
            dictation_locale: String::new(),
            notify_mentions: true,
            notify_tasks: true,
            private_notification_previews: false,
            version: 1,
        }
    }
}

fn normalize(mut preferences: WorkspacePreferences) -> WorkspacePreferences {
    preferences.dictation_locale = preferences
        .dictation_locale
        .trim()
        .chars()
        .take(35)
        .collect();
    preferences.version = 1;
    preferences
}

fn load(path: &Path) -> WorkspacePreferences {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<WorkspacePreferences>(&bytes).ok())
        .map(normalize)
        .unwrap_or_default()
}

fn save(path: &Path, preferences: WorkspacePreferences) -> Result<WorkspacePreferences, String> {
    let preferences = normalize(preferences);
    let parent = path.parent().ok_or("preferences directory unavailable")?;
    fs::create_dir_all(parent).map_err(|_| "preferences directory unavailable")?;
    let temporary = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec(&preferences).map_err(|_| "preferences are invalid")?;
    fs::write(&temporary, serialized).map_err(|_| "preferences could not be saved")?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "preferences could not be replaced")?;
    }
    fs::rename(&temporary, path).map_err(|_| "preferences could not be saved")?;
    Ok(preferences)
}

fn preferences_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(PREFERENCES_FILE))
        .map_err(|_| "preferences directory unavailable".to_string())
}

#[tauri::command]
pub fn desktop_preferences_load<R: Runtime>(
    app: AppHandle<R>,
) -> Result<WorkspacePreferences, String> {
    Ok(load(&preferences_path(&app)?))
}

#[tauri::command]
pub fn desktop_preferences_save<R: Runtime>(
    app: AppHandle<R>,
    preferences: WorkspacePreferences,
) -> Result<WorkspacePreferences, String> {
    save(&preferences_path(&app)?, preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_contains_only_bounded_product_preferences() {
        let directory = tempfile::tempdir().expect("temporary preferences directory");
        let path = directory.path().join(PREFERENCES_FILE);
        let saved = save(
            &path,
            WorkspacePreferences {
                dictation_locale: format!(" en-US{} ", "x".repeat(80)),
                notify_mentions: false,
                notify_tasks: true,
                private_notification_previews: false,
                version: 99,
            },
        )
        .expect("save preferences");
        assert_eq!(saved.version, 1);
        assert_eq!(saved.dictation_locale.chars().count(), 35);
        assert_eq!(load(&path), saved);
        let bytes = fs::read_to_string(path).expect("read preferences");
        assert!(!bytes.contains("credential"));
        assert!(!bytes.contains("plaintext"));
    }

    #[test]
    fn corrupt_preferences_fail_closed_to_defaults() {
        let directory = tempfile::tempdir().expect("temporary preferences directory");
        let path = directory.path().join(PREFERENCES_FILE);
        fs::write(&path, b"not json").expect("write corrupt preferences");
        assert_eq!(load(&path), WorkspacePreferences::default());
    }
}
