use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::cloud::cloud_origin;

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

const CALLBACK_URI: &str = "adea://auth/callback";
const AUTHORIZATION_PATH: &str = "/api/auth/desktop/authorize";
const CALLBACK_EVENT: &str = "desktop-auth-callback-ready";
const AUTH_ATTEMPT_KEYCHAIN_USER: &str = "desktop-authorization-attempt";
const SESSION_KEYCHAIN_SERVICE: &str = "com.adea.desktop";
const SESSION_KEYCHAIN_USER: &str = "desktop-user-session";
const TEMPORARY_WORKSPACE_KEYCHAIN_USER: &str = "temporary-workspace-session";
const FORBIDDEN_PARAMETERS: [&str; 5] = [
    "access_token",
    "id_token",
    "refresh_token",
    "session_token",
    "token",
];

#[derive(Clone, Default)]
pub struct DesktopAuthState(Arc<Mutex<Option<String>>>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUserSession {
    credential: String,
    expires_at: String,
    session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthorizationAttempt {
    code_challenge: String,
    code_verifier: String,
    expires_at: u64,
    nonce: String,
    redirect_uri: String,
    state: String,
    used: bool,
}

fn base64url(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn validate_authorization_attempt(
    attempt: &DesktopAuthorizationAttempt,
) -> Result<(), &'static str> {
    if !base64url(&attempt.code_challenge, 43, 128)
        || !base64url(&attempt.code_verifier, 43, 128)
        || !base64url(&attempt.nonce, 16, 512)
        || !base64url(&attempt.state, 16, 512)
        || attempt.expires_at == 0
        || attempt.redirect_uri != CALLBACK_URI
        || attempt.used
    {
        return Err("invalid desktop authorization attempt");
    }
    Ok(())
}

fn validate_user_session(session: &DesktopUserSession) -> Result<(), &'static str> {
    if !(32..=512).contains(&session.credential.len())
        || !(16..=128).contains(&session.session_id.len())
        || !(20..=64).contains(&session.expires_at.len())
        || session.credential.chars().any(char::is_whitespace)
        || session.session_id.chars().any(char::is_whitespace)
    {
        return Err("invalid desktop user session");
    }
    Ok(())
}

fn validate_temporary_workspace_credential(credential: &str) -> Result<(), &'static str> {
    let Some(secret) = credential.strip_prefix("adea_tmp_") else {
        return Err("invalid temporary workspace credential");
    };
    if !base64url(secret, 43, 43) {
        return Err("invalid temporary workspace credential");
    }
    Ok(())
}

fn session_entry() -> Result<Entry, String> {
    Entry::new(SESSION_KEYCHAIN_SERVICE, SESSION_KEYCHAIN_USER)
        .map_err(|_| "desktop user session vault is unavailable".to_string())
}

fn authorization_attempt_entry() -> Result<Entry, String> {
    Entry::new(SESSION_KEYCHAIN_SERVICE, AUTH_ATTEMPT_KEYCHAIN_USER)
        .map_err(|_| "desktop authorization vault is unavailable".to_string())
}

fn temporary_workspace_entry() -> Result<Entry, String> {
    Entry::new(SESSION_KEYCHAIN_SERVICE, TEMPORARY_WORKSPACE_KEYCHAIN_USER)
        .map_err(|_| "temporary workspace vault is unavailable".to_string())
}

impl DesktopAuthState {
    fn replace(&self, callback: String) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(callback);
    }

    fn take(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

fn bounded(value: Option<&String>, minimum: usize, maximum: usize) -> bool {
    value.is_some_and(|value| value.len() >= minimum && value.len() <= maximum)
}

fn query(url: &Url) -> Result<HashMap<String, String>, &'static str> {
    let mut values = HashMap::new();
    for (name, value) in url.query_pairs() {
        if values
            .insert(name.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("duplicate desktop authorization parameter");
        }
    }
    Ok(values)
}

fn validate_authorization_url(raw_url: &str) -> Result<Url, &'static str> {
    let url = Url::parse(raw_url).map_err(|_| "invalid desktop authorization URL")?;
    let expected = Url::parse(cloud_origin()).map_err(|_| "invalid desktop cloud origin")?;
    if url.scheme() != expected.scheme()
        || url.host_str() != expected.host_str()
        || url.port_or_known_default() != expected.port_or_known_default()
        || url.path() != AUTHORIZATION_PATH
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("untrusted desktop authorization URL");
    }

    let values = query(&url)?;
    if values
        .keys()
        .any(|name| FORBIDDEN_PARAMETERS.contains(&name.as_str()))
    {
        return Err("desktop authorization URL must not contain credentials");
    }
    if values.len() != 7
        || values.get("client").map(String::as_str) != Some("desktop")
        || values.get("code_challenge_method").map(String::as_str) != Some("S256")
        || values.get("redirect_uri").map(String::as_str) != Some(CALLBACK_URI)
        || values.get("response_type").map(String::as_str) != Some("code")
        || !bounded(values.get("code_challenge"), 43, 128)
        || !bounded(values.get("nonce"), 16, 512)
        || !bounded(values.get("state"), 16, 512)
    {
        return Err("invalid desktop authorization parameters");
    }
    Ok(url)
}

fn validate_callback_url(raw_url: &str) -> Result<Url, &'static str> {
    let url = Url::parse(raw_url).map_err(|_| "invalid desktop callback URL")?;
    if format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.path()
    ) != CALLBACK_URI
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("untrusted desktop callback URL");
    }

    let values = query(&url)?;
    if values
        .keys()
        .any(|name| FORBIDDEN_PARAMETERS.contains(&name.as_str()))
    {
        return Err("desktop callback URL must not contain credentials");
    }
    if values.len() != 3
        || !bounded(values.get("code"), 8, 512)
        || !bounded(values.get("nonce"), 16, 512)
        || !bounded(values.get("state"), 16, 512)
    {
        return Err("invalid desktop callback parameters");
    }
    Ok(url)
}

#[tauri::command]
pub fn desktop_auth_start<R: Runtime>(
    app: AppHandle<R>,
    authorization_url: String,
) -> Result<(), String> {
    let url = validate_authorization_url(&authorization_url).map_err(str::to_owned)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "failed to open desktop authorization in the system browser".to_string())
}

#[tauri::command]
pub fn desktop_auth_take_callback(state: State<'_, DesktopAuthState>) -> Option<String> {
    state.take()
}

#[tauri::command]
pub async fn desktop_auth_attempt_save(attempt: DesktopAuthorizationAttempt) -> Result<(), String> {
    validate_authorization_attempt(&attempt).map_err(str::to_owned)?;
    tauri::async_runtime::spawn_blocking(move || {
        let serialized = serde_json::to_string(&attempt)
            .map_err(|_| "desktop authorization attempt could not be serialized".to_string())?;
        authorization_attempt_entry()?
            .set_password(&serialized)
            .map_err(|_| "desktop authorization attempt could not be saved".to_string())
    })
    .await
    .map_err(|_| "desktop authorization vault task failed".to_string())?
}

#[tauri::command]
pub async fn desktop_auth_attempt_load() -> Result<Option<DesktopAuthorizationAttempt>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match authorization_attempt_entry()?.get_password() {
            Ok(serialized) => {
                let attempt: DesktopAuthorizationAttempt = serde_json::from_str(&serialized)
                    .map_err(|_| "desktop authorization attempt is invalid".to_string())?;
                validate_authorization_attempt(&attempt).map_err(str::to_owned)?;
                Ok(Some(attempt))
            }
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err("desktop authorization attempt could not be loaded".to_string()),
        }
    })
    .await
    .map_err(|_| "desktop authorization vault task failed".to_string())?
}

#[tauri::command]
pub async fn desktop_auth_attempt_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        match authorization_attempt_entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err("desktop authorization attempt could not be cleared".to_string()),
        }
    })
    .await
    .map_err(|_| "desktop authorization vault task failed".to_string())?
}

#[tauri::command]
pub async fn desktop_user_session_save(session: DesktopUserSession) -> Result<(), String> {
    validate_user_session(&session).map_err(str::to_owned)?;
    tauri::async_runtime::spawn_blocking(move || {
        let serialized = serde_json::to_string(&session)
            .map_err(|_| "desktop user session could not be serialized".to_string())?;
        session_entry()?
            .set_password(&serialized)
            .map_err(|_| "desktop user session could not be saved".to_string())
    })
    .await
    .map_err(|_| "desktop user session vault task failed".to_string())?
}

#[tauri::command]
pub async fn desktop_user_session_load() -> Result<Option<DesktopUserSession>, String> {
    tauri::async_runtime::spawn_blocking(move || match session_entry()?.get_password() {
        Ok(serialized) => {
            let session: DesktopUserSession = serde_json::from_str(&serialized)
                .map_err(|_| "desktop user session is invalid".to_string())?;
            validate_user_session(&session).map_err(str::to_owned)?;
            Ok(Some(session))
        }
        Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err("desktop user session could not be loaded".to_string()),
    })
    .await
    .map_err(|_| "desktop user session vault task failed".to_string())?
}

#[tauri::command]
pub async fn desktop_user_session_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match session_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err("desktop user session could not be cleared".to_string()),
    })
    .await
    .map_err(|_| "desktop user session vault task failed".to_string())?
}

#[tauri::command]
pub async fn desktop_temporary_workspace_save(credential: String) -> Result<(), String> {
    validate_temporary_workspace_credential(&credential).map_err(str::to_owned)?;
    tauri::async_runtime::spawn_blocking(move || {
        temporary_workspace_entry()?
            .set_password(&credential)
            .map_err(|_| "temporary workspace credential could not be saved".to_string())
    })
    .await
    .map_err(|_| "temporary workspace vault task failed".to_string())?
}

#[tauri::command]
pub async fn desktop_temporary_workspace_load() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match temporary_workspace_entry()?.get_password() {
            Ok(credential) => {
                validate_temporary_workspace_credential(&credential).map_err(str::to_owned)?;
                Ok(Some(credential))
            }
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err("temporary workspace credential could not be loaded".to_string()),
        }
    })
    .await
    .map_err(|_| "temporary workspace vault task failed".to_string())?
}

#[tauri::command]
pub async fn desktop_temporary_workspace_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        match temporary_workspace_entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err("temporary workspace credential could not be cleared".to_string()),
        }
    })
    .await
    .map_err(|_| "temporary workspace vault task failed".to_string())?
}

pub fn queue_callback<R: Runtime>(app: &AppHandle<R>, raw_url: &str) -> bool {
    if let Ok(url) = validate_callback_url(raw_url) {
        app.state::<DesktopAuthState>().replace(url.to_string());
        let _ = app.emit(CALLBACK_EVENT, ());
        return true;
    }
    false
}

fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    let _ = app.show();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// A callback that reaches an already-running app must surface the window that
/// is waiting for it, otherwise the sign-in looks like it did nothing.
pub fn receive_auth_callback<R: Runtime>(app: &AppHandle<R>, raw_url: &str) {
    if queue_callback(app, raw_url) {
        reveal_main_window(app);
    }
}

/// Own the callback channel: register the scheme where the platform requires
/// it, deliver a callback that launched this process, and listen for later
/// ones. Returns the failing step's detail when the channel cannot be opened.
pub fn start_deep_link_channel<R: Runtime>(app: &tauri::App<R>) -> Result<(), String> {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link()
        .register_all()
        .map_err(|error| format!("deep link registration: {error}"))?;

    if let Some(urls) = app
        .deep_link()
        .get_current()
        .map_err(|error| format!("deep link handoff: {error}"))?
    {
        for url in urls {
            queue_callback(app.handle(), url.as_str());
        }
    }

    let app_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            receive_auth_callback(&app_handle, url.as_str());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_authorization_url() -> String {
        let mut url = Url::parse(&format!("{}{}", cloud_origin(), AUTHORIZATION_PATH)).unwrap();
        url.query_pairs_mut()
            .append_pair("client", "desktop")
            .append_pair("code_challenge", &"c".repeat(43))
            .append_pair("code_challenge_method", "S256")
            .append_pair("nonce", &"n".repeat(32))
            .append_pair("redirect_uri", CALLBACK_URI)
            .append_pair("response_type", "code")
            .append_pair("state", &"s".repeat(32));
        url.to_string()
    }

    #[test]
    fn accepts_only_the_fixed_cloud_authorization_endpoint() {
        assert!(validate_authorization_url(&valid_authorization_url()).is_ok());
        let evil = valid_authorization_url().replace(cloud_origin(), "https://evil.example");
        assert_eq!(
            validate_authorization_url(&evil),
            Err("untrusted desktop authorization URL")
        );
    }

    #[test]
    fn rejects_callback_replays_that_carry_credentials_or_wrong_origins() {
        let valid = format!(
            "{CALLBACK_URI}?code=one-time-code&nonce={}&state={}",
            "n".repeat(32),
            "s".repeat(32)
        );
        assert!(validate_callback_url(&valid).is_ok());
        assert_eq!(
            validate_callback_url(&format!("{valid}&access_token=secret")),
            Err("desktop callback URL must not contain credentials")
        );
        assert_eq!(
            validate_callback_url(&valid.replace(CALLBACK_URI, "https://evil.example/callback")),
            Err("untrusted desktop callback URL")
        );
    }

    #[test]
    fn pending_callback_is_taken_exactly_once() {
        let state = DesktopAuthState::default();
        state.replace("adea://auth/callback?code=one-time-code".into());
        assert!(state.take().is_some());
        assert!(state.take().is_none());
    }

    #[test]
    fn user_session_vault_rejects_malformed_credentials() {
        let session = DesktopUserSession {
            credential: "short".into(),
            expires_at: "2030-01-01T00:00:00.000Z".into(),
            session_id: "018fc7c8-4a45-7e7c-9b92-3e5eafca4ed1".into(),
        };
        assert_eq!(
            validate_user_session(&session),
            Err("invalid desktop user session")
        );
    }

    #[test]
    fn temporary_workspace_vault_accepts_only_opaque_guest_credentials() {
        let valid = format!("adea_tmp_{}", "a".repeat(43));
        assert!(validate_temporary_workspace_credential(&valid).is_ok());
        assert_eq!(
            validate_temporary_workspace_credential("adea_tmp_short"),
            Err("invalid temporary workspace credential")
        );
        assert_eq!(
            validate_temporary_workspace_credential(&format!("adea_tmp_{}", "!".repeat(43))),
            Err("invalid temporary workspace credential")
        );
    }

    #[test]
    fn authorization_attempt_vault_rejects_untrusted_or_consumed_state() {
        let valid = DesktopAuthorizationAttempt {
            code_challenge: "c".repeat(43),
            code_verifier: "v".repeat(64),
            expires_at: 1,
            nonce: "n".repeat(32),
            redirect_uri: CALLBACK_URI.to_string(),
            state: "s".repeat(32),
            used: false,
        };
        assert!(validate_authorization_attempt(&valid).is_ok());

        let mut consumed = valid.clone();
        consumed.used = true;
        assert_eq!(
            validate_authorization_attempt(&consumed),
            Err("invalid desktop authorization attempt")
        );

        let mut untrusted = valid;
        untrusted.redirect_uri = "https://evil.example/callback".to_string();
        assert_eq!(
            validate_authorization_attempt(&untrusted),
            Err("invalid desktop authorization attempt")
        );
    }
}
