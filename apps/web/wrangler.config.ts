import { defineWranglerConfig } from 'wrangler/experimental-config'

// Tooling-side settings for the cf deploy path; the worker itself is
// configured in cloudflare.config.ts. The Vite plugin already bundles the
// worker, so cf must not re-bundle it.
export default defineWranglerConfig({
  noBundle: true,
  assetsDirectory: './dist/client',
  rules: [
    // The Vite build emits additional server modules under
    // dist/server/start-assets/ that index.js imports at runtime.
    {
      type: 'ESModule',
      globs: ['**/*.js', '**/*.mjs'],
    },
  ],
})
