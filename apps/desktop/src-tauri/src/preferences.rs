//! Versioned product preferences.
//!
//! The preferences file is a JSON document owned by the native shell. The
//! packaged client round-trips a typed subset of it, and native features keep
//! their own groups in the same document (window geometry, for one). Two rules
//! keep that safe across builds:
//!
//! - **Integer `schemaVersion`, with a migration chain.** Migrations run on
//!   load, in order, and the result is written back. A document written by a
//!   *newer* build is never downgraded or reinterpreted: known fields are still
//!   read, and everything else is left exactly as it was found.
//! - **Warn-and-preserve.** A key this build does not read survives every save
//!   verbatim — a field a newer build wrote, or one a retired feature wrote.
//!   Retired keys are declared in a registry so their warning names the
//!   replacement instead of looking like corruption.
//!
//! Saving merges: the typed subset the client sends updates only its own keys,
//! so a save never drops a group or a field it does not know about.

use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tauri::{AppHandle, Manager, Runtime};

const PREFERENCES_FILE: &str = "workspace-preferences.json";
const SCHEMA_VERSION_KEY: &str = "schemaVersion";
/// Longest dictation locale the cloud API and the speech recognizer accept.
const MAX_DICTATION_LOCALE_CHARS: usize = 35;

/// The typed subset the packaged client reads and writes.
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

/// A key this build no longer reads, kept so its warning is actionable.
struct DeprecatedKey {
    key: &'static str,
    replacement: &'static str,
}

/// How one schema version becomes the next.
struct Migration {
    from: u32,
    apply: fn(&mut JsonMap<String, JsonValue>),
}

/// Known fields, retired keys, and the migration chain for the preferences
/// document. Tests build their own schema to exercise migrations and
/// retirements, which no release has needed yet.
struct PreferencesSchema {
    current_version: u32,
    deprecated: &'static [DeprecatedKey],
    migrations: &'static [Migration],
}

/// The first version stamp: documents written before the shell versioned its
/// preferences simply gain the field, and keep everything else untouched, which
/// the migration runner does on its own. The chain is empty until a setting
/// actually changes shape; the runner and its ordering are covered by tests
/// through a synthetic schema.
const PRODUCT_SCHEMA: PreferencesSchema = PreferencesSchema {
    current_version: 1,
    // Nothing has been retired yet. The first retired key goes here, with the
    // replacement that makes its warning useful.
    deprecated: &[],
    migrations: &[],
};

/// Where the preferences document lives, and the typed view of it.
#[derive(Clone, Debug)]
pub struct PreferencesStore {
    path: std::path::PathBuf,
}

impl PreferencesStore {
    pub fn new(path: std::path::PathBuf) -> Self {
        Self { path }
    }

    /// Resolve the store inside the app config directory.
    pub fn at_app_config<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        app.path()
            .app_config_dir()
            .map(|directory| Self::new(directory.join(PREFERENCES_FILE)))
            .map_err(|_| "preferences directory unavailable".to_string())
    }

    /// Test-only: the unit tests read and write the document directly.
    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// The stored document, migrated and normalized, or `None` when the file is
    /// missing or unreadable. Corrupt content fails closed to defaults.
    pub fn document(&self) -> Option<JsonMap<String, JsonValue>> {
        let bytes = fs::read(&self.path).ok()?;
        let value: JsonValue = serde_json::from_slice(&bytes).ok()?;
        let mut document = value.as_object()?.clone();
        let warnings = self.schema().migrate(&mut document);
        log_warnings(&warnings);
        Some(document)
    }

    /// Read the typed projection. A missing, unreadable, or corrupt document
    /// reads as defaults, which is what the packaged client expects on a fresh
    /// install.
    pub fn load(&self) -> WorkspacePreferences {
        self.document()
            .map(|document| PRODUCT_SCHEMA.project(&document))
            .unwrap_or_default()
    }

    /// Merge the typed subset into the stored document and write it back.
    pub fn save(&self, preferences: WorkspacePreferences) -> Result<WorkspacePreferences, String> {
        let mut document = self.document().unwrap_or_default();
        PRODUCT_SCHEMA.merge(&mut document, &preferences);
        let warnings = self.schema().migrate(&mut document);
        log_warnings(&warnings);
        self.write(&document)?;
        Ok(PRODUCT_SCHEMA.project(&document))
    }

    /// A native-owned group (window geometry, capability toggles) inside the
    /// same versioned document, so it survives client saves.
    pub fn group(&self, key: &str) -> Option<JsonValue> {
        self.document()?.get(key).cloned()
    }

    pub fn set_group(&self, key: &str, value: JsonValue) -> Result<(), String> {
        let mut document = self.document().unwrap_or_default();
        document.insert(key.to_string(), value);
        self.write(&document)
    }

    fn schema(&self) -> &PreferencesSchema {
        &PRODUCT_SCHEMA
    }

    fn write(&self, document: &JsonMap<String, JsonValue>) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or("preferences directory unavailable")?;
        fs::create_dir_all(parent).map_err(|_| "preferences directory unavailable")?;
        let temporary = self.path.with_extension("json.tmp");
        let serialized = serde_json::to_vec(&JsonValue::Object(document.clone()))
            .map_err(|_| "preferences are invalid")?;
        fs::write(&temporary, serialized).map_err(|_| "preferences could not be saved")?;
        #[cfg(target_os = "windows")]
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(|_| "preferences could not be replaced")?;
        }
        fs::rename(&temporary, &self.path).map_err(|_| "preferences could not be saved")?;
        Ok(())
    }
}

impl PreferencesSchema {
    /// Apply every migration the document needs, stamp the current version, and
    /// report what changed. A document from a newer build is left untouched.
    fn migrate(&self, document: &mut JsonMap<String, JsonValue>) -> Vec<String> {
        let mut warnings = Vec::new();
        let stored = stored_version(document);

        // The chain has to be dense and start at zero, or a document could skip
        // a step and keep settings in a shape nothing reads.
        debug_assert!(
            self.migrations
                .iter()
                .enumerate()
                .all(|(index, migration)| migration.from == index as u32),
            "the migration chain must be dense and start at version 0"
        );

        if stored > self.current_version {
            warnings.push(format!(
                "preferences were written by a newer Adea build (schema {stored}); unknown settings are preserved but not interpreted"
            ));
        } else {
            for migration in self.migrations.iter().filter(|entry| entry.from >= stored) {
                (migration.apply)(document);
            }
            if stored < self.current_version {
                document.insert(
                    SCHEMA_VERSION_KEY.to_string(),
                    JsonValue::from(self.current_version),
                );
            }
        }

        warnings.extend(self.retired_key_warnings(document));
        warnings
    }

    fn retired_key_warnings(&self, document: &JsonMap<String, JsonValue>) -> Vec<String> {
        self.deprecated
            .iter()
            .filter(|deprecated| document.contains_key(deprecated.key))
            .map(|deprecated| {
                format!(
                    "preference \"{}\" is no longer read and is preserved as written; use \"{}\"",
                    deprecated.key, deprecated.replacement
                )
            })
            .collect()
    }

    /// The typed projection: known fields only, normalized.
    fn project(&self, document: &JsonMap<String, JsonValue>) -> WorkspacePreferences {
        let defaults = WorkspacePreferences::default();
        let mut preferences = WorkspacePreferences {
            dictation_locale: document
                .get("dictationLocale")
                .and_then(JsonValue::as_str)
                .map(str::to_owned)
                .unwrap_or(defaults.dictation_locale),
            notify_mentions: document
                .get("notifyMentions")
                .and_then(JsonValue::as_bool)
                .unwrap_or(defaults.notify_mentions),
            notify_tasks: document
                .get("notifyTasks")
                .and_then(JsonValue::as_bool)
                .unwrap_or(defaults.notify_tasks),
            private_notification_previews: document
                .get("privateNotificationPreviews")
                .and_then(JsonValue::as_bool)
                .unwrap_or(defaults.private_notification_previews),
            version: defaults.version,
        };
        preferences.normalize();
        preferences
    }

    /// Update only the keys this build owns; every other key, including groups
    /// owned by native features, is left as it was found.
    fn merge(&self, document: &mut JsonMap<String, JsonValue>, incoming: &WorkspacePreferences) {
        let mut incoming = incoming.clone();
        incoming.normalize();
        document.insert(
            "dictationLocale".to_string(),
            JsonValue::from(incoming.dictation_locale),
        );
        document.insert(
            "notifyMentions".to_string(),
            JsonValue::from(incoming.notify_mentions),
        );
        document.insert(
            "notifyTasks".to_string(),
            JsonValue::from(incoming.notify_tasks),
        );
        document.insert(
            "privateNotificationPreviews".to_string(),
            JsonValue::from(incoming.private_notification_previews),
        );
        document.insert("version".to_string(), JsonValue::from(incoming.version));
    }
}

impl WorkspacePreferences {
    fn normalize(&mut self) {
        self.dictation_locale = self
            .dictation_locale
            .trim()
            .chars()
            .take(MAX_DICTATION_LOCALE_CHARS)
            .collect();
        self.version = 1;
    }
}

/// The schema version a document declares. Anything that is not a version
/// number is treated as an unversioned document rather than trusted.
fn stored_version(document: &JsonMap<String, JsonValue>) -> u32 {
    match document.get(SCHEMA_VERSION_KEY) {
        None => 0,
        Some(value) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(0),
    }
}

/// Warnings are diagnostics, not control flow: the shell has no logging
/// facility, and stderr is what the system log captures for a bundled app.
fn log_warnings(warnings: &[String]) {
    for warning in warnings {
        eprintln!("[adea] preferences: {warning}");
    }
}

#[tauri::command]
pub fn desktop_preferences_load<R: Runtime>(
    app: AppHandle<R>,
) -> Result<WorkspacePreferences, String> {
    Ok(PreferencesStore::at_app_config(&app)?.load())
}

#[tauri::command]
pub fn desktop_preferences_save<R: Runtime>(
    app: AppHandle<R>,
    preferences: WorkspacePreferences,
) -> Result<WorkspacePreferences, String> {
    PreferencesStore::at_app_config(&app)?.save(preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, PreferencesStore) {
        let directory = tempfile::tempdir().expect("temporary preferences directory");
        let store = PreferencesStore::new(directory.path().join(PREFERENCES_FILE));
        (directory, store)
    }

    fn read_document(store: &PreferencesStore) -> JsonMap<String, JsonValue> {
        let bytes = fs::read(store.path()).expect("read preferences");
        serde_json::from_slice::<JsonValue>(&bytes)
            .expect("preferences parse")
            .as_object()
            .expect("preferences are an object")
            .clone()
    }

    #[test]
    fn round_trip_contains_only_bounded_product_preferences() {
        let (_directory, store) = store();
        let saved = store
            .save(WorkspacePreferences {
                dictation_locale: format!(" en-US{} ", "x".repeat(80)),
                notify_mentions: false,
                notify_tasks: true,
                private_notification_previews: false,
                version: 99,
            })
            .expect("save preferences");
        assert_eq!(saved.version, 1);
        assert_eq!(
            saved.dictation_locale.chars().count(),
            MAX_DICTATION_LOCALE_CHARS
        );
        assert_eq!(store.load(), saved);
        let bytes = fs::read_to_string(store.path()).expect("read preferences");
        assert!(!bytes.contains("credential"));
        assert!(!bytes.contains("plaintext"));
    }

    #[test]
    fn corrupt_preferences_fail_closed_to_defaults() {
        let (_directory, store) = store();
        fs::write(store.path(), b"not json").expect("write corrupt preferences");
        assert_eq!(store.load(), WorkspacePreferences::default());
        // A corrupt document must not stop the next save from succeeding.
        assert!(store.save(WorkspacePreferences::default()).is_ok());
    }

    #[test]
    fn an_unversioned_document_gains_the_schema_version_and_keeps_its_keys() {
        let (_directory, store) = store();
        fs::write(
            store.path(),
            br#"{"dictationLocale":"en-GB","notifyMentions":false,"window":{"width":1200}}"#,
        )
        .expect("write legacy preferences");

        let loaded = store.load();
        assert_eq!(loaded.dictation_locale, "en-GB");
        assert!(!loaded.notify_mentions);
        assert!(loaded.notify_tasks, "a missing key reads as its default");

        // Loading alone does not rewrite the file; the first save stamps it.
        assert!(store.save(loaded).is_ok());
        let document = read_document(&store);
        assert_eq!(
            document.get(SCHEMA_VERSION_KEY),
            Some(&JsonValue::from(PRODUCT_SCHEMA.current_version))
        );
        assert_eq!(
            document.get("window"),
            Some(&serde_json::json!({ "width": 1200 })),
            "native groups survive a client save"
        );
    }

    #[test]
    fn a_save_never_drops_fields_this_build_does_not_read() {
        let (_directory, store) = store();
        fs::write(
            store.path(),
            br#"{"schemaVersion":1,"dictationLocale":"","futureToggle":true,"nested":{"a":[1,2]}}"#,
        )
        .expect("write preferences");

        store
            .save(WorkspacePreferences {
                dictation_locale: "fr-FR".to_string(),
                notify_mentions: false,
                notify_tasks: false,
                private_notification_previews: true,
                version: 1,
            })
            .expect("save preferences");

        let document = read_document(&store);
        assert_eq!(
            document.get("futureToggle"),
            Some(&JsonValue::Bool(true)),
            "a field a newer build wrote is preserved verbatim"
        );
        assert_eq!(
            document.get("nested"),
            Some(&serde_json::json!({ "a": [1, 2] }))
        );
        assert_eq!(
            document.get("dictationLocale"),
            Some(&JsonValue::from("fr-FR"))
        );
    }

    #[test]
    fn a_document_from_a_newer_build_is_read_but_not_downgraded() {
        let directory = tempfile::tempdir().expect("temporary preferences directory");
        let store = PreferencesStore::new(directory.path().join(PREFERENCES_FILE));
        fs::write(
            store.path(),
            br#"{"schemaVersion":99,"dictationLocale":"de-DE","fromTheFuture":{"x":1}}"#,
        )
        .expect("write newer preferences");

        assert_eq!(store.load().dictation_locale, "de-DE");
        store
            .save(WorkspacePreferences {
                dictation_locale: "de-DE".to_string(),
                ..WorkspacePreferences::default()
            })
            .expect("save preferences");

        let document = read_document(&store);
        assert_eq!(
            document.get(SCHEMA_VERSION_KEY),
            Some(&JsonValue::from(99)),
            "a newer schema version is never rewritten downwards"
        );
        assert_eq!(
            document.get("fromTheFuture"),
            Some(&serde_json::json!({ "x": 1 }))
        );
    }

    #[test]
    fn migrations_run_in_order_from_the_stored_version() {
        fn rename_legacy(document: &mut JsonMap<String, JsonValue>) {
            if let Some(value) = document.remove("legacyLocale") {
                document.insert("dictationLocale".to_string(), value);
            }
        }
        fn stamp_replacements(document: &mut JsonMap<String, JsonValue>) {
            document.insert("migrated".to_string(), JsonValue::Bool(true));
        }

        let schema = PreferencesSchema {
            current_version: 2,
            deprecated: &[],
            migrations: &[
                Migration {
                    from: 0,
                    apply: rename_legacy,
                },
                Migration {
                    from: 1,
                    apply: stamp_replacements,
                },
            ],
        };
        let mut document: JsonMap<String, JsonValue> =
            serde_json::json!({ "schemaVersion": 1, "legacyLocale": "en-CA" })
                .as_object()
                .expect("object")
                .clone();

        let warnings = schema.migrate(&mut document);
        assert!(warnings.is_empty());
        assert_eq!(
            document.get("legacyLocale"),
            Some(&JsonValue::from("en-CA")),
            "a migration that already ran does not run again"
        );
        assert_eq!(document.get("migrated"), Some(&JsonValue::Bool(true)));
        assert_eq!(document.get(SCHEMA_VERSION_KEY), Some(&JsonValue::from(2)));
    }

    #[test]
    fn retired_keys_warn_with_their_replacement_and_survive_saves() {
        let directory = tempfile::tempdir().expect("temporary preferences directory");
        let store = PreferencesStore::new(directory.path().join(PREFERENCES_FILE));
        fs::write(
            store.path(),
            br#"{"schemaVersion":1,"notifyMentions":true,"mentionEmails":true}"#,
        )
        .expect("write preferences");

        let schema = PreferencesSchema {
            current_version: 1,
            deprecated: &[DeprecatedKey {
                key: "mentionEmails",
                replacement: "notifyMentions",
            }],
            migrations: PRODUCT_SCHEMA.migrations,
        };
        let mut document = read_document(&store);
        let warnings = schema.migrate(&mut document);

        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("mentionEmails"));
        assert!(warnings[0].contains("notifyMentions"));

        store
            .save(WorkspacePreferences::default())
            .expect("save preferences");
        assert_eq!(
            read_document(&store).get("mentionEmails"),
            Some(&JsonValue::Bool(true)),
            "a retired key is preserved, not dropped"
        );
    }

    #[test]
    fn a_native_group_round_trips_through_client_saves() {
        let (_directory, store) = store();
        store
            .set_group(
                "window",
                serde_json::json!({ "width": 1440, "maximized": true }),
            )
            .expect("write group");
        assert_eq!(
            store.group("window"),
            Some(serde_json::json!({ "width": 1440, "maximized": true }))
        );

        store
            .save(WorkspacePreferences {
                notify_tasks: false,
                ..WorkspacePreferences::default()
            })
            .expect("save preferences");
        assert_eq!(
            store
                .group("window")
                .and_then(|value| value.get("width").cloned()),
            Some(JsonValue::from(1440))
        );
    }

    #[test]
    fn a_non_numeric_schema_version_is_treated_as_unversioned() {
        let mut document: JsonMap<String, JsonValue> =
            serde_json::json!({ "schemaVersion": "one", "notifyMentions": false })
                .as_object()
                .expect("object")
                .clone();
        assert_eq!(stored_version(&document), 0);
        let warnings = PRODUCT_SCHEMA.migrate(&mut document);
        assert!(warnings.is_empty());
        assert_eq!(
            document.get(SCHEMA_VERSION_KEY),
            Some(&JsonValue::from(PRODUCT_SCHEMA.current_version))
        );
        assert_eq!(
            document.get("notifyMentions"),
            Some(&JsonValue::Bool(false)),
            "recovery from a malformed version does not discard settings"
        );
    }
}
