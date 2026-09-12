import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/postcss'

import { DEFAULT_CLOUD_ORIGIN, normalizeDesktopCloudOrigin } from './scripts/tauri-cloud-config.mjs'

// The packaged client reads the cloud origin from the same source as the
// packaged CSP and the native authorization allowlist (see
// `src-tauri/src/cloud.rs`): `scripts/tauri.mjs` exports the validated value,
// and a plain `vite build` falls back to the release default. Keeping the
// literal in one place is what `scripts/desktop-origin-boundary.test.ts`
// enforces.
const cloudOrigin = normalizeDesktopCloudOrigin(
  process.env.VITE_ADEA_CLOUD_ORIGIN ?? process.env.ADEA_CLOUD_ORIGIN ?? DEFAULT_CLOUD_ORIGIN
)

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  define: { __ADEA_CLOUD_ORIGIN__: JSON.stringify(cloudOrigin) },
  publicDir: '../web/public',
  resolve: { dedupe: ['react', 'react-dom'] },
})
