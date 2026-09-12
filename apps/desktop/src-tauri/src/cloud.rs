//! The single native source of truth for the cloud origin.
//!
//! The shell talks only to the exact origin baked in at build time. Three call
//! sites have to agree on it: the packaged CSP, the native authorization
//! allowlist in [`crate::auth`], and the browser-safe broker that the packaged
//! client configures. This module owns the native constant;
//! `scripts/check-desktop-origins.mjs` fails the build when a second origin
//! literal appears anywhere in the shell, and
//! `scripts/desktop-origin-boundary.test.ts` pins this constant to the value
//! the Tauri build wrapper writes into the CSP.

/// The origin a release build talks to. Release builds default to the hosted
/// Adea deployment; the value is part of the product's security surface, not a
/// user preference.
pub const DEFAULT_CLOUD_ORIGIN: &str = "https://adea.dev";

/// The compile-time cloud origin.
///
/// `scripts/tauri.mjs` sets `VITE_ADEA_CLOUD_ORIGIN` after validating and
/// normalizing it, so native code reads the same value the packaged CSP was
/// generated from. `ADEA_CLOUD_ORIGIN` is accepted for callers that build the
/// crate without the wrapper.
pub fn cloud_origin() -> &'static str {
    option_env!("VITE_ADEA_CLOUD_ORIGIN")
        .or(option_env!("ADEA_CLOUD_ORIGIN"))
        .unwrap_or(DEFAULT_CLOUD_ORIGIN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_origin_is_a_bare_https_origin() {
        let url = url::Url::parse(DEFAULT_CLOUD_ORIGIN).expect("the default origin parses");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("adea.dev"));
        assert_eq!(url.port_or_known_default(), Some(443));
        assert_eq!(url.path(), "/");
        assert!(url.username().is_empty());
        assert!(url.password().is_none());
        assert!(url.query().is_none());
        assert!(url.fragment().is_none());
    }

    #[test]
    fn the_compile_time_origin_is_a_bare_origin() {
        // The build wrapper supplies an already-normalized origin; a malformed
        // value would otherwise surface as a request to the wrong host.
        let origin = cloud_origin();
        let url = url::Url::parse(origin).expect("the compile-time origin parses");
        assert!(matches!(url.scheme(), "https" | "http"));
        assert_eq!(url.path(), "/");
        assert!(url.username().is_empty());
        assert!(url.password().is_none());
        assert!(url.query().is_none());
    }
}
