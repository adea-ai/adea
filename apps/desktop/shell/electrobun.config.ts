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
