use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex as AsyncMutex;

const GITHUB_URL: &str = "https://github.com/adea-ai/adea";
const MAX_RELEASE_NOTES_CHARS: usize = 32_000;
const UPDATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
const CHANGELOG: &str = include_str!("../../../../CHANGELOG.md");

#[derive(Clone, Debug, Serialize)]
pub struct UpdateSnapshot {
    pub current_version: String,
    pub available_version: Option<String>,
    pub release_date: Option<String>,
    pub release_notes: Option<String>,
    pub changelog: String,
    pub github_url: &'static str,
    pub phase: &'static str,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub restart_required: bool,
}

impl Default for UpdateSnapshot {
    fn default() -> Self {
        Self {
            current_version: env!("CARGO_PKG_VERSION").into(),
            available_version: None,
            release_date: None,
            release_notes: None,
            changelog: bounded(CHANGELOG, MAX_RELEASE_NOTES_CHARS),
            github_url: GITHUB_URL,
            phase: "idle",
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            restart_required: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct UpdaterState {
    operation: Arc<AsyncMutex<()>>,
    pending: Arc<AsyncMutex<Option<Update>>>,
    snapshot: Arc<Mutex<UpdateSnapshot>>,
}

impl UpdaterState {
    pub fn status<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> UpdateSnapshot {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        snapshot.current_version = app.package_info().version.to_string();
        snapshot
    }

    pub async fn check<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<UpdateSnapshot, String> {
        let _operation = self.operation.lock().await;
        self.update_snapshot(|snapshot| {
            snapshot.current_version = app.package_info().version.to_string();
            snapshot.phase = "checking";
            snapshot.error = None;
            snapshot.available_version = None;
            snapshot.release_date = None;
            snapshot.release_notes = None;
            snapshot.downloaded_bytes = 0;
            snapshot.total_bytes = None;
            snapshot.restart_required = false;
        });

        let result = match app.updater() {
            Ok(updater) => updater
                .check()
                .await
                .map_err(|error| format!("check for signed Adea update: {error}")),
            Err(error) => Err(format!("initialize signed Adea updater: {error}")),
        };

        match result {
            Ok(Some(update)) => {
                let available_version = update.version.clone();
                let release_date = update.date.map(|value| value.to_string());
                let release_notes = update
                    .body
                    .as_deref()
                    .map(|value| bounded(value, MAX_RELEASE_NOTES_CHARS));
                *self.pending.lock().await = Some(update);
                self.update_snapshot(|snapshot| {
                    snapshot.phase = "available";
                    snapshot.available_version = Some(available_version);
                    snapshot.release_date = release_date;
                    snapshot.release_notes = release_notes;
                    snapshot.error = None;
                });
                Ok(self.status(app))
            }
            Ok(None) => {
                *self.pending.lock().await = None;
                self.update_snapshot(|snapshot| {
                    snapshot.phase = "current";
                    snapshot.available_version = None;
                    snapshot.release_date = None;
                    snapshot.release_notes = None;
                    snapshot.error = None;
                });
                Ok(self.status(app))
            }
            Err(error) => {
                *self.pending.lock().await = None;
                self.update_snapshot(|snapshot| {
                    snapshot.phase = "failed";
                    snapshot.available_version = None;
                    snapshot.error = Some(error.clone());
                });
                Err(error)
            }
        }
    }

    pub async fn install<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        expected_version: &str,
        approved: bool,
        restart: bool,
    ) -> Result<UpdateSnapshot, String> {
        let _operation = self.operation.lock().await;
        let pending = self.pending.lock().await.take();
        let update = match validate_install_request(
            approved,
            expected_version,
            pending.as_ref().map(|update| update.version.as_str()),
        ) {
            Ok(()) => match pending {
                Some(update) => update,
                None => return Err("check for an update before installing".into()),
            },
            Err(error) => {
                if let Some(update) = pending {
                    *self.pending.lock().await = Some(update);
                }
                return Err(error.into());
            }
        };

        self.update_snapshot(|snapshot| {
            snapshot.phase = "downloading";
            snapshot.downloaded_bytes = 0;
            snapshot.total_bytes = None;
            snapshot.error = None;
        });

        let progress = self.snapshot.clone();
        let progress_finished = self.snapshot.clone();
        let retry = update.clone();
        let result = match tokio::time::timeout(
            UPDATE_TIMEOUT,
            update.download_and_install(
                move |chunk, total| {
                    let mut snapshot = progress
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    snapshot.phase = "downloading";
                    snapshot.downloaded_bytes =
                        snapshot.downloaded_bytes.saturating_add(chunk as u64);
                    snapshot.total_bytes = total;
                },
                move || {
                    let mut snapshot = progress_finished
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    snapshot.phase = "installing";
                },
            ),
        )
        .await
        {
            Ok(result) => {
                result.map_err(|error| format!("verify and install signed Adea update: {error}"))
            }
            Err(_) => Err(format!(
                "signed Adea update timed out after {} seconds",
                UPDATE_TIMEOUT.as_secs()
            )),
        };

        if let Err(error) = result {
            *self.pending.lock().await = Some(retry);
            self.update_snapshot(|snapshot| {
                snapshot.phase = "failed";
                snapshot.error = Some(error.clone());
            });
            return Err(error);
        }

        self.update_snapshot(|snapshot| {
            snapshot.phase = "installed";
            snapshot.error = None;
            snapshot.restart_required = true;
        });
        let snapshot = self.status(app);
        if restart {
            app.request_restart();
        }
        Ok(snapshot)
    }

    fn update_snapshot(&self, update: impl FnOnce(&mut UpdateSnapshot)) {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        update(&mut snapshot);
    }
}

#[tauri::command]
pub fn desktop_update_status<R: tauri::Runtime>(
    app: AppHandle<R>,
    updater: State<'_, UpdaterState>,
) -> UpdateSnapshot {
    updater.status(&app)
}

#[tauri::command]
pub async fn desktop_update_check<R: tauri::Runtime>(
    app: AppHandle<R>,
    updater: State<'_, UpdaterState>,
) -> Result<UpdateSnapshot, String> {
    updater.check(&app).await
}

#[tauri::command]
pub async fn desktop_update_install<R: tauri::Runtime>(
    app: AppHandle<R>,
    updater: State<'_, UpdaterState>,
    expected_version: String,
    approved: bool,
    restart: bool,
) -> Result<UpdateSnapshot, String> {
    updater
        .install(&app, &expected_version, approved, restart)
        .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallGuardError {
    ApprovalRequired,
    InvalidVersion,
    NoPendingUpdate,
    VersionMismatch,
}

impl From<InstallGuardError> for String {
    fn from(error: InstallGuardError) -> Self {
        match error {
            InstallGuardError::ApprovalRequired => {
                "update installation requires explicit approval".into()
            }
            InstallGuardError::InvalidVersion => "invalid expected update version".into(),
            InstallGuardError::NoPendingUpdate => "check for an update before installing".into(),
            InstallGuardError::VersionMismatch => {
                "available update changed; check again before installing".into()
            }
        }
    }
}

fn validate_install_request(
    approved: bool,
    expected_version: &str,
    pending_version: Option<&str>,
) -> Result<(), InstallGuardError> {
    if !approved {
        return Err(InstallGuardError::ApprovalRequired);
    }
    if expected_version.is_empty() || expected_version.len() > 64 {
        return Err(InstallGuardError::InvalidVersion);
    }
    match pending_version {
        None => Err(InstallGuardError::NoPendingUpdate),
        Some(pending) if pending != expected_version => Err(InstallGuardError::VersionMismatch),
        Some(_) => Ok(()),
    }
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_plain_changelog_source() {
        let snapshot = UpdateSnapshot::default();
        assert_eq!(snapshot.github_url, GITHUB_URL);
        // `bounded` budgets characters; byte length is not the invariant (the
        // bundled changelog contains multi-byte punctuation).
        assert!(snapshot.changelog.chars().count() <= MAX_RELEASE_NOTES_CHARS);
        assert!(snapshot.changelog.contains("Changelog"));
    }

    #[test]
    fn install_guard_requires_approval_and_matching_version() {
        assert_eq!(
            validate_install_request(false, "0.3.0", Some("0.3.0")),
            Err(InstallGuardError::ApprovalRequired)
        );
        assert_eq!(
            validate_install_request(true, "0.3.0", Some("0.3.1")),
            Err(InstallGuardError::VersionMismatch)
        );
        assert!(validate_install_request(true, "0.3.0", Some("0.3.0")).is_ok());
    }
}
