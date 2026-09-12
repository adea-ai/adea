//! Typed boot pipeline for the desktop shell.
//!
//! Startup used to end in a bare `expect`, which made every failure mode
//! indistinguishable to both the user and the next launch. This module owns
//! the shell's startup instead:
//!
//! - Every failure is classified into a [`BootFailureKind`] with its own
//!   guidance, summary, and retry policy.
//! - Every launch appends to a persisted [`LaunchLog`], so a launch that dies
//!   during startup can still be diagnosed from the launch after it.
//! - A failed launch ends in a native recovery dialog offering retry or quit,
//!   never in a panic.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{App, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Directory name the launch log lives under, shared with the app identifier
/// so log locations are predictable across platforms.
const LOG_DIRECTORY_NAME: &str = "com.adea.desktop";
const LAUNCH_LOG_FILENAME: &str = "launch-log.jsonl";
const WRITE_PROBE_FILENAME: &str = ".boot-write-probe";
/// Records kept per log file; older launches are dropped on rotation.
const MAX_LAUNCH_RECORDS: usize = 64;
const MAX_DETAIL_CHARS: usize = 240;
/// Bounded retries: a boot step that keeps failing must not loop forever.
const MAX_BOOT_ATTEMPTS: usize = 3;

/// Named startup failure kinds. Each carries its own user guidance and retry
/// policy, so a caller never has to guess whether retrying is safe.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BootFailureKind {
    /// The packaged frontend assets are missing, so no window can be shown.
    /// A reinstalled or rebuilt bundle resolves this, which makes it retryable.
    IncompleteBundle,
    /// The data or config directory cannot be created or written. Retrying
    /// cannot fix a full disk or a permissions problem, so this one quits
    /// instead of looping.
    DataDirUnavailable,
    /// A native service the shell depends on (signed updates, the deep-link
    /// channel) failed to start. Often transient, so it is retryable.
    NativeServiceUnavailable,
    /// The webview window could not be created. Typically transient (resource
    /// exhaustion, a racing single-instance handoff), so it is retryable.
    WebviewFailure,
}

impl BootFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IncompleteBundle => "incompleteBundle",
            Self::DataDirUnavailable => "dataDirUnavailable",
            Self::NativeServiceUnavailable => "nativeServiceUnavailable",
            Self::WebviewFailure => "webviewFailure",
        }
    }

    /// One line naming what failed, used in launch-log summaries.
    pub fn summary(self) -> &'static str {
        match self {
            Self::IncompleteBundle => "the packaged application assets are missing",
            Self::DataDirUnavailable => "the settings directory is not writable",
            Self::NativeServiceUnavailable => "a native service did not start",
            Self::WebviewFailure => "the application window could not be created",
        }
    }

    /// What the user can do about it.
    pub fn guidance(self) -> &'static str {
        match self {
            Self::IncompleteBundle => {
                "Adea could not find its bundled application files. Reinstall Adea, or rebuild \
                 the app, and try again."
            }
            Self::DataDirUnavailable => {
                "Adea could not write its settings directory. Free disk space or fix permissions \
                 for that directory, then relaunch Adea."
            }
            Self::NativeServiceUnavailable => {
                "Adea could not start one of its native services. Close other copies of Adea and \
                 try again."
            }
            Self::WebviewFailure => {
                "Adea could not open its window. Close other copies of Adea and try again."
            }
        }
    }

    pub fn retryable(self) -> bool {
        match self {
            Self::IncompleteBundle | Self::NativeServiceUnavailable | Self::WebviewFailure => true,
            Self::DataDirUnavailable => false,
        }
    }
}

/// A classified startup failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootError {
    kind: BootFailureKind,
    detail: String,
}

impl BootError {
    pub fn new(kind: BootFailureKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: bounded_detail(&detail.into()),
        }
    }

    pub fn kind(&self) -> BootFailureKind {
        self.kind
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    pub fn guidance(&self) -> &'static str {
        self.kind.guidance()
    }

    pub fn retryable(&self) -> bool {
        self.kind.retryable()
    }
}

impl std::fmt::Display for BootError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}({})",
            self.kind.as_str(),
            if self.detail.is_empty() {
                self.kind.summary()
            } else {
                &self.detail
            }
        )
    }
}

impl std::error::Error for BootError {}

/// Log-file directory rules per platform. Kept as data so every platform's
/// resolution can be tested from any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogPlatform {
    MacOs,
    Windows,
    Linux,
}

impl LogPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// Environment inputs used to resolve the launch-log directory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LogEnvironment {
    pub home: Option<String>,
    pub local_app_data: Option<String>,
    pub xdg_state_home: Option<String>,
}

impl LogEnvironment {
    pub fn from_process() -> Self {
        fn read(name: &str) -> Option<String> {
            std::env::var(name).ok().filter(|value| !value.is_empty())
        }
        Self {
            home: read("HOME").or_else(|| read("USERPROFILE")),
            local_app_data: read("LOCALAPPDATA"),
            xdg_state_home: read("XDG_STATE_HOME"),
        }
    }
}

/// Resolve the launch-log directory. Returns `None` when the platform's base
/// directory cannot be determined, which disables logging rather than failing
/// the launch.
pub fn log_directory_for(platform: LogPlatform, environment: &LogEnvironment) -> Option<PathBuf> {
    let directory = match platform {
        LogPlatform::MacOs => PathBuf::from(environment.home.as_deref()?)
            .join("Library")
            .join("Logs")
            .join(LOG_DIRECTORY_NAME),
        LogPlatform::Windows => PathBuf::from(environment.local_app_data.as_deref()?)
            .join(LOG_DIRECTORY_NAME)
            .join("logs"),
        LogPlatform::Linux => {
            let state_home = match environment.xdg_state_home.as_deref() {
                Some(state_home) => PathBuf::from(state_home),
                None => PathBuf::from(environment.home.as_deref()?)
                    .join(".local")
                    .join("state"),
            };
            state_home.join(LOG_DIRECTORY_NAME).join("logs")
        }
    };
    Some(directory)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchEvent {
    Started,
    Ready,
    Failed,
    Exited,
    /// A second launch forwarded its arguments to this instance and ended.
    /// Recorded by the receiving instance, because the forwarding process is
    /// terminated by the single-instance plugin before it can log its own exit.
    HandoffReceived,
}

/// One launch-log line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRecord {
    pub at_ms: u64,
    pub version: String,
    pub event: LaunchEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<BootFailureKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl LaunchRecord {
    pub fn new(event: LaunchEvent) -> Self {
        Self {
            at_ms: now_ms(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            event,
            kind: None,
            detail: None,
        }
    }

    pub fn failed(error: &BootError) -> Self {
        Self {
            kind: Some(error.kind()),
            detail: Some(error.detail().to_string()),
            ..Self::new(LaunchEvent::Failed)
        }
    }

    /// What the previous launch did, from the perspective of this launch.
    pub fn describe(&self) -> String {
        match self.event {
            LaunchEvent::Started => "The previous launch stopped during startup.".to_string(),
            LaunchEvent::Failed => format!(
                "The previous launch failed to start: {}{}",
                self.kind
                    .map(|kind| kind.summary())
                    .unwrap_or("an unknown startup failure"),
                self.detail
                    .as_deref()
                    .filter(|detail| !detail.is_empty())
                    .map(|detail| format!(" ({detail})"))
                    .unwrap_or_default()
            ),
            LaunchEvent::HandoffReceived => {
                "The previous launch handed off to the copy that was already running.".to_string()
            }
            LaunchEvent::Ready => "The previous launch ended without a clean exit.".to_string(),
            LaunchEvent::Exited => "The previous launch exited normally.".to_string(),
        }
    }
}

/// Append-only JSONL history of launches. Every operation is best effort: a
/// launch log that cannot be written must never fail the launch.
#[derive(Clone, Debug, Default)]
pub struct LaunchLog {
    directory: Option<PathBuf>,
}

impl LaunchLog {
    pub fn from_process() -> Self {
        Self::new(log_directory_for(
            LogPlatform::current(),
            &LogEnvironment::from_process(),
        ))
    }

    pub fn new(directory: Option<PathBuf>) -> Self {
        Self { directory }
    }

    pub fn path(&self) -> Option<PathBuf> {
        self.directory
            .as_ref()
            .map(|dir| dir.join(LAUNCH_LOG_FILENAME))
    }

    /// Append one record, rotating the file when the history grows past the
    /// cap. Returns whether the record reached disk.
    pub fn append(&self, record: &LaunchRecord) -> bool {
        let Some(path) = self.path() else {
            return false;
        };
        if let Some(parent) = path.parent() {
            if fs::create_dir_all(parent).is_err() {
                return false;
            }
        }
        let Ok(line) = serde_json::to_string(record) else {
            return false;
        };
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
            return false;
        };
        if writeln!(file, "{line}").is_err() {
            return false;
        }
        self.rotate_if_needed(&path);
        true
    }

    /// Every parseable record, oldest first. Unparseable lines (a torn write
    /// from a killed process) are skipped instead of discarding the history.
    pub fn read(&self) -> Vec<LaunchRecord> {
        let Some(path) = self.path() else {
            return Vec::new();
        };
        let Ok(contents) = fs::read_to_string(path) else {
            return Vec::new();
        };
        contents
            .lines()
            .filter_map(|line| serde_json::from_str::<LaunchRecord>(line).ok())
            .collect()
    }

    /// The last record written by an earlier launch, read before this launch
    /// appends its own start marker.
    pub fn previous_launch(&self) -> Option<LaunchRecord> {
        self.read().into_iter().next_back()
    }

    fn rotate_if_needed(&self, path: &Path) {
        let records = self.read();
        if records.len() <= MAX_LAUNCH_RECORDS {
            return;
        }
        let kept = records.len() - MAX_LAUNCH_RECORDS;
        let body = records
            .into_iter()
            .skip(kept)
            .filter_map(|record| serde_json::to_string(&record).ok())
            .collect::<Vec<_>>()
            .join("\n");
        let _ = fs::write(path, format!("{body}\n"));
    }
}

/// Startup diagnostics shared by the setup hook and the launch owner: the
/// launch log, the previous launch's outcome, and the typed failure recorded
/// by a failed setup (which Tauri only reports as an opaque error).
#[derive(Clone, Default)]
pub struct BootDiagnostics {
    log: LaunchLog,
    previous: Arc<Mutex<Option<LaunchRecord>>>,
    failure: Arc<Mutex<Option<BootError>>>,
}

impl BootDiagnostics {
    pub fn from_process() -> Self {
        let log = LaunchLog::from_process();
        let previous = log.previous_launch();
        Self {
            log,
            previous: Arc::new(Mutex::new(previous)),
            failure: Arc::new(Mutex::new(None)),
        }
    }

    pub fn previous_launch(&self) -> Option<LaunchRecord> {
        self.previous
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Record that another launch handed its arguments to this instance.
    pub fn record_handoff(&self) {
        self.record(LaunchRecord::new(LaunchEvent::HandoffReceived));
    }

    fn record(&self, record: LaunchRecord) {
        self.log.append(&record);
    }

    fn record_failure(&self, error: &BootError) {
        *self
            .failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error.clone());
        self.record(LaunchRecord::failed(error));
    }

    fn take_failure(&self) -> Option<BootError> {
        self.failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

/// Boot steps that can fail, in the order a launch depends on them. Every step
/// is safe to run again, because the retry path re-enters this whole list.
fn start<R: Runtime>(app: &mut App<R>) -> Result<(), BootError> {
    verify_bundled_assets(app)?;
    prepare_writable_directories(app)?;
    register_native_services(app)?;
    initialize_local_content(app)?;
    create_main_window(app)
}

/// The signed-update service and the deep-link channel both fail closed: a
/// shell without them cannot update itself or finish a sign-in handoff.
fn register_native_services<R: Runtime>(app: &mut App<R>) -> Result<(), BootError> {
    #[cfg(desktop)]
    app.handle()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .map_err(|error| {
            BootError::new(
                BootFailureKind::NativeServiceUnavailable,
                format!("signed update service: {error}"),
            )
        })?;

    crate::auth::start_deep_link_channel(app)
        .map_err(|detail| BootError::new(BootFailureKind::NativeServiceUnavailable, detail))
}

/// The encrypted local content store is initialized before any window can call
/// its commands. `initialize` degrades to an unavailable store on its own, so
/// only an unresolvable data directory is a boot failure.
fn initialize_local_content<R: Runtime>(app: &mut App<R>) -> Result<(), BootError> {
    if app
        .try_state::<crate::local_content::LocalContentState>()
        .is_some()
    {
        return Ok(());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| BootError::new(BootFailureKind::DataDirUnavailable, error.to_string()))?;
    app.manage(crate::local_content::LocalContentState::initialize(
        &directory,
    ));
    Ok(())
}

/// The packaged bundle must contain the entry document, otherwise the main
/// window would open onto nothing. Development builds serve the client from
/// the Vite dev server, so the packaged check does not apply there.
#[cfg(not(dev))]
fn verify_bundled_assets<R: Runtime>(app: &App<R>) -> Result<(), BootError> {
    if app.asset_resolver().get("index.html".to_string()).is_none() {
        return Err(BootError::new(
            BootFailureKind::IncompleteBundle,
            "the packaged assets do not contain index.html",
        ));
    }
    Ok(())
}

#[cfg(dev)]
fn verify_bundled_assets<R: Runtime>(_app: &App<R>) -> Result<(), BootError> {
    Ok(())
}

/// Both directories are written on every launch (preferences and the encrypted
/// local-content database), so an unwritable one is a boot failure worth
/// reporting before a window exists.
fn prepare_writable_directories<R: Runtime>(app: &App<R>) -> Result<(), BootError> {
    let directories = [app.path().app_data_dir(), app.path().app_config_dir()];
    for directory in directories.into_iter().flatten() {
        if let Err(error) = probe_writable_directory(&directory) {
            return Err(BootError::new(
                BootFailureKind::DataDirUnavailable,
                format!("{} ({error})", directory.display()),
            ));
        }
    }
    Ok(())
}

fn probe_writable_directory(directory: &Path) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    let probe = directory.join(WRITE_PROBE_FILENAME);
    fs::write(&probe, b"")?;
    fs::remove_file(&probe)
}

fn create_main_window<R: Runtime>(app: &mut App<R>) -> Result<(), BootError> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Adea")
        .inner_size(1440.0, 960.0)
        .min_inner_size(960.0, 640.0)
        .build()
        .map(|_| ())
        .map_err(|error| BootError::new(BootFailureKind::WebviewFailure, error.to_string()))
}

/// Install the boot steps as the Tauri setup hook. A retryable failure asks the
/// user before running the steps again; a non-retryable one quits immediately.
pub fn install<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let diagnostics = app.state::<BootDiagnostics>().inner().clone();
    let mut attempt = 0;
    loop {
        attempt += 1;
        match start(app) {
            Ok(()) => {
                diagnostics.record(LaunchRecord::new(LaunchEvent::Ready));
                return Ok(());
            }
            Err(error) => {
                diagnostics.record_failure(&error);
                let attempts_left = attempt < MAX_BOOT_ATTEMPTS;
                if !error.retryable() || !attempts_left || !confirm_retry(&error, &diagnostics) {
                    return Err(Box::new(error));
                }
            }
        }
    }
}

/// Own the process lifetime: record the launch, build the app, and end a failed
/// launch in a native dialog instead of a panic. Returns the process exit code.
pub fn launch(builder: tauri::Builder<tauri::Wry>, diagnostics: BootDiagnostics) -> i32 {
    diagnostics.record(LaunchRecord::new(LaunchEvent::Started));

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            let boot_error = diagnostics.take_failure().unwrap_or_else(|| {
                let boot_error = BootError::new(BootFailureKind::WebviewFailure, error.to_string());
                diagnostics.record_failure(&boot_error);
                boot_error
            });
            report_fatal(&boot_error, &diagnostics);
            return 1;
        }
    };

    let exit_diagnostics = diagnostics.clone();
    app.run(move |_handle, event| {
        if let tauri::RunEvent::Exit = event {
            exit_diagnostics.record(LaunchRecord::new(LaunchEvent::Exited));
        }
    });

    0
}

fn confirm_retry(error: &BootError, diagnostics: &BootDiagnostics) -> bool {
    let result = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Adea could not start")
        .set_description(dialog_message(error, diagnostics, true))
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            "Retry".to_string(),
            "Quit".to_string(),
        ))
        .show();
    matches!(result, rfd::MessageDialogResult::Custom(label) if label == "Retry")
}

fn report_fatal(error: &BootError, diagnostics: &BootDiagnostics) {
    let _ = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Adea could not start")
        .set_description(dialog_message(error, diagnostics, false))
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

fn dialog_message(error: &BootError, diagnostics: &BootDiagnostics, retrying: bool) -> String {
    let mut message = String::from(error.guidance());
    if !error.detail().is_empty() {
        message.push_str("\n\nDetails: ");
        message.push_str(error.detail());
    }
    if let Some(previous) = diagnostics.previous_launch() {
        message.push_str("\n\n");
        message.push_str(&previous.describe());
    }
    if !retrying {
        message.push_str("\n\nAdea will now close.");
    }
    message
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Single-line, bounded detail text: launch-log lines and dialog text must not
/// carry unbounded or multi-line payloads from the underlying error.
fn bounded_detail(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_DETAIL_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every failure kind, so the taxonomy tests stay exhaustive as it grows.
    const BOOT_FAILURE_KINDS: [BootFailureKind; 4] = [
        BootFailureKind::IncompleteBundle,
        BootFailureKind::DataDirUnavailable,
        BootFailureKind::NativeServiceUnavailable,
        BootFailureKind::WebviewFailure,
    ];

    fn temp_log() -> (tempfile::TempDir, LaunchLog) {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let log = LaunchLog::new(Some(directory.path().to_path_buf()));
        (directory, log)
    }

    #[test]
    fn every_failure_kind_carries_guidance_and_a_retry_policy() {
        for kind in BOOT_FAILURE_KINDS {
            assert!(!kind.as_str().is_empty());
            assert!(!kind.summary().is_empty());
            assert!(kind.guidance().ends_with('.'));
        }
        // A full disk or a permissions problem must not be retried into a loop.
        assert!(!BootFailureKind::DataDirUnavailable.retryable());
        assert!(BootFailureKind::IncompleteBundle.retryable());
        assert!(BootFailureKind::NativeServiceUnavailable.retryable());
        assert!(BootFailureKind::WebviewFailure.retryable());
    }

    #[test]
    fn failure_kinds_round_trip_through_the_log_format() {
        for kind in BOOT_FAILURE_KINDS {
            let record = LaunchRecord::failed(&BootError::new(kind, "detail"));
            let serialized = serde_json::to_string(&record).expect("record serializes");
            let parsed: LaunchRecord = serde_json::from_str(&serialized).expect("record parses");
            assert_eq!(parsed.kind, Some(kind));
            assert_eq!(parsed.event, LaunchEvent::Failed);
            assert_eq!(parsed.detail.as_deref(), Some("detail"));
        }
    }

    #[test]
    fn error_detail_is_single_line_and_bounded() {
        let error = BootError::new(
            BootFailureKind::DataDirUnavailable,
            format!("line one\nline two {}", "x".repeat(MAX_DETAIL_CHARS * 2)),
        );
        assert!(!error.detail().contains('\n'));
        assert_eq!(error.detail().chars().count(), MAX_DETAIL_CHARS);
        assert!(error.to_string().starts_with("dataDirUnavailable("));
    }

    #[test]
    fn launch_log_records_are_append_only_and_readable_in_order() {
        let (_directory, log) = temp_log();
        assert!(log.append(&LaunchRecord::new(LaunchEvent::Started)));
        assert!(log.append(&LaunchRecord::new(LaunchEvent::Ready)));
        assert!(log.append(&LaunchRecord::new(LaunchEvent::Exited)));

        let events: Vec<_> = log.read().into_iter().map(|record| record.event).collect();
        assert_eq!(
            events,
            vec![
                LaunchEvent::Started,
                LaunchEvent::Ready,
                LaunchEvent::Exited
            ]
        );
        assert_eq!(
            log.previous_launch().map(|record| record.event),
            Some(LaunchEvent::Exited)
        );
    }

    #[test]
    fn a_launch_that_died_during_startup_leaves_a_started_marker() {
        let (_directory, log) = temp_log();
        log.append(&LaunchRecord::new(LaunchEvent::Ready));
        log.append(&LaunchRecord::new(LaunchEvent::Exited));
        log.append(&LaunchRecord::new(LaunchEvent::Started));

        let previous = log.previous_launch().expect("previous launch record");
        assert_eq!(previous.event, LaunchEvent::Started);
        assert_eq!(
            previous.describe(),
            "The previous launch stopped during startup."
        );
    }

    #[test]
    fn failed_launches_are_summarized_with_their_kind() {
        let error = BootError::new(BootFailureKind::IncompleteBundle, "no index.html");
        let description = LaunchRecord::failed(&error).describe();
        assert!(description.contains(BootFailureKind::IncompleteBundle.summary()));
        assert!(description.contains("no index.html"));
    }

    #[test]
    fn a_handoff_is_reported_as_an_expected_end() {
        let description = LaunchRecord::new(LaunchEvent::HandoffReceived).describe();
        assert!(description.contains("handed off"));

        // The receiving instance writes the record, so a handoff is never
        // mistaken for a crash during startup.
        let (_directory, log) = temp_log();
        log.append(&LaunchRecord::new(LaunchEvent::Started));
        log.append(&LaunchRecord::new(LaunchEvent::HandoffReceived));
        let previous = log.previous_launch().expect("previous launch record");
        assert_eq!(previous.event, LaunchEvent::HandoffReceived);
        assert!(!previous.describe().contains("stopped during startup"));
    }

    #[test]
    fn launch_log_rotates_without_unbounded_growth() {
        let (_directory, log) = temp_log();
        for _ in 0..(MAX_LAUNCH_RECORDS + 12) {
            log.append(&LaunchRecord::new(LaunchEvent::Exited));
        }
        assert_eq!(log.read().len(), MAX_LAUNCH_RECORDS);
    }

    #[test]
    fn torn_log_lines_do_not_discard_the_history() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let log = LaunchLog::new(Some(directory.path().to_path_buf()));
        log.append(&LaunchRecord::new(LaunchEvent::Ready));
        let path = log.path().expect("log path");
        let mut file = OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open log for append");
        write!(file, "{{\"atMs\":1").expect("write torn record");

        assert_eq!(log.read().len(), 1);
    }

    #[test]
    fn a_log_without_a_directory_is_inert() {
        let log = LaunchLog::new(None);
        assert!(!log.append(&LaunchRecord::new(LaunchEvent::Started)));
        assert!(log.read().is_empty());
        assert!(log.previous_launch().is_none());
    }

    #[test]
    fn log_directories_follow_platform_conventions() {
        let environment = LogEnvironment {
            home: Some("/home/owner".to_string()),
            local_app_data: Some("C:\\Users\\owner\\AppData\\Local".to_string()),
            xdg_state_home: None,
        };
        assert_eq!(
            log_directory_for(LogPlatform::MacOs, &environment),
            Some(
                PathBuf::from("/home/owner")
                    .join("Library")
                    .join("Logs")
                    .join("com.adea.desktop")
            )
        );
        assert_eq!(
            log_directory_for(LogPlatform::Windows, &environment),
            Some(
                PathBuf::from("C:\\Users\\owner\\AppData\\Local")
                    .join("com.adea.desktop")
                    .join("logs")
            )
        );
        assert_eq!(
            log_directory_for(LogPlatform::Linux, &environment),
            Some(
                PathBuf::from("/home/owner")
                    .join(".local")
                    .join("state")
                    .join("com.adea.desktop")
                    .join("logs")
            )
        );

        let with_state_home = LogEnvironment {
            xdg_state_home: Some("/state".to_string()),
            ..environment.clone()
        };
        assert_eq!(
            log_directory_for(LogPlatform::Linux, &with_state_home),
            Some(
                PathBuf::from("/state")
                    .join("com.adea.desktop")
                    .join("logs")
            )
        );

        let without_home = LogEnvironment {
            home: None,
            ..environment
        };
        assert_eq!(log_directory_for(LogPlatform::MacOs, &without_home), None);
        assert_eq!(log_directory_for(LogPlatform::Linux, &without_home), None);
    }

    #[test]
    fn boot_diagnostics_keep_the_previous_launch_and_the_recorded_failure() {
        let directory = tempfile::tempdir().expect("temporary log directory");
        let log = LaunchLog::new(Some(directory.path().to_path_buf()));
        log.append(&LaunchRecord::new(LaunchEvent::Started));

        let diagnostics = BootDiagnostics {
            log: log.clone(),
            previous: Arc::new(Mutex::new(log.previous_launch())),
            failure: Arc::new(Mutex::new(None)),
        };
        assert_eq!(
            diagnostics.previous_launch().map(|record| record.event),
            Some(LaunchEvent::Started)
        );

        let error = BootError::new(BootFailureKind::WebviewFailure, "window failed");
        diagnostics.record_failure(&error);
        assert_eq!(diagnostics.take_failure(), Some(error));
        assert!(diagnostics.take_failure().is_none());
        assert_eq!(
            log.read()
                .into_iter()
                .next_back()
                .map(|record| record.event),
            Some(LaunchEvent::Failed)
        );
    }
}
