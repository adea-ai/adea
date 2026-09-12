/**
 * Build-time constants injected by `vite.config.ts`.
 *
 * `__ADEA_CLOUD_ORIGIN__` is the validated cloud origin the desktop build
 * selects: the same value the packaged CSP and the native authorization
 * allowlist use (`src-tauri/src/cloud.rs`, `scripts/tauri-cloud-config.mjs`).
 */
declare const __ADEA_CLOUD_ORIGIN__: string
