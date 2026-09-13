/**
 * Build-time constants injected by `vite.config.ts`.
 *
 * `__ADEA_CLOUD_ORIGIN__` is the validated cloud origin the desktop build
 * selects: the single literal lives in `scripts/cloud-config.mjs` and every
 * consumer imports it from there.
 */
declare const __ADEA_CLOUD_ORIGIN__: string
