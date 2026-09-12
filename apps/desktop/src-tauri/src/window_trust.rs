//! Which webview is allowed to call privileged commands.
//!
//! Every privileged command answers only the bundled main window: the packaged
//! client runs from the app's own scheme, a development build runs from the
//! local Vite server, and anything else — a navigated webview, a lookalike
//! origin, another window — is untrusted.

use tauri::{Runtime, Url, WebviewWindow};

/// Whether the calling webview is the bundled main window.
pub fn is_trusted_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    if window.label() != "main" {
        return false;
    }
    window.url().map(|url| trusted_url(&url)).unwrap_or(false)
}

/// The packaged scheme, plus the loopback dev server in development builds.
pub fn trusted_url(url: &Url) -> bool {
    let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (cfg!(target_os = "windows")
            && url.scheme() == "https"
            && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port() == Some(1420);
    packaged || development
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_origin_check_rejects_navigated_or_lookalike_pages() {
        assert!(trusted_url(
            &Url::parse("tauri://localhost/index.html").expect("packaged url")
        ));
        assert!(!trusted_url(
            &Url::parse("https://tauri.localhost/index.html").expect("web url")
        ));
        assert!(!trusted_url(
            &Url::parse("https://evil.example/index.html").expect("hostile url")
        ));
        assert!(!trusted_url(
            &Url::parse("tauri://localhost.evil.example/index.html").expect("lookalike url")
        ));
    }
}
