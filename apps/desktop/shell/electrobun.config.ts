import type { ElectrobunConfig } from 'electrobun'
import desktopPackage from '../package.json'

// Adea desktop shell: Bun main process with bundled CEF
// (docs/decisions/0006-browser-lanes-and-desktop-shell.md).
export default {
  app: {
    name: 'Adea',
    identifier: 'dev.adea.desktop',
    version: desktopPackage.version,
    // The packaged desktop's sign-in callback scheme (macOS only in Electrobun
    // 2.0.1). This is the source declaration the signed packaging lane reads to
    // register `adea://`; the shell's receiver subscribes to the resulting
    // `open-url` event (`src/auth-callback-channel.ts`). See
    // docs/specs/desktop-auth.md "The callback".
    urlSchemes: ['adea'],
  },
  build: {
    mainProcess: 'bun',
    views: {},
    // The single-UI client (apps/web's SPA build) is copied into the bundle so
    // the packaged app is self-contained; the shell resolves it next to the
    // bundled main process. Staged by apps/desktop/scripts/client.mjs.
    copy: {
      '../../web/dist-desktop/client': 'client',
      // The installed changelog shown in the Version & updates dialog is the
      // repository's full release history (matching Cortana's updater), read
      // at runtime next to the bundled main process.
      '../../../CHANGELOG.md': 'CHANGELOG.md',
      // The Dev Runtime terminal sidecar is a bundled supervised component
      // (M10 #185 / #396): the packaging lane bundles the entry into
      // build/sidecar-dist and stages it at
      // Contents/Resources/app/dev-runtime-sidecar — the install location
      // shell/scripts/packaged-install.ts resolves for the component manifest.
      'build/sidecar-dist': 'dev-runtime-sidecar',
      // The managed agent archive at the driver's pin. The driver installs
      // it from Contents/Resources/app/managed-pi before trying the network,
      // so a fresh install works offline and without a release endpoint.
      // Bump this file with MANAGED_PI_PINNED_VERSION and its digest.
      'resources/managed-pi': 'managed-pi',
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
