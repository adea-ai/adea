import type { ElectrobunConfig } from 'electrobun'

// Adea desktop shell: Bun main process with bundled CEF
// (docs/decisions/0006-browser-lanes-and-desktop-shell.md).
export default {
  app: {
    name: 'Adea',
    identifier: 'dev.adea.desktop',
    version: '0.1.0',
  },
  build: {
    mainProcess: 'bun',
    views: {},
    // The single-UI client (apps/web's SPA build) is copied into the bundle so
    // the packaged app is self-contained; the shell resolves it next to the
    // bundled main process. Staged by apps/desktop/scripts/client.mjs.
    copy: {
      '../../web/dist-desktop/client': 'client',
    },
    mac: {
      bundleCEF: true,
    },
    linux: {
      bundleCEF: true,
    },
    win: {
      bundleCEF: true,
    },
  },
} satisfies ElectrobunConfig
