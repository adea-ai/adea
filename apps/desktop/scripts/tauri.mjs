import { spawnSync } from 'node:child_process'

import { createTauriCloudConfig, normalizeDesktopCloudOrigin } from './tauri-cloud-config.mjs'

const [command, ...arguments_] = process.argv.slice(2)
if (command !== 'build' && command !== 'dev') {
  throw new Error('Desktop Tauri wrapper requires the build or dev command')
}

const cloudOrigin = normalizeDesktopCloudOrigin(
  process.env.VITE_ADEA_CLOUD_ORIGIN ?? process.env.ADEA_CLOUD_ORIGIN
)

// Prefer a stable local code-signing identity when the caller did not pick
// one. Ad-hoc-signed builds change identity on every rebuild, which voids
// the Keychain ACL grants each rebuild created and makes macOS re-prompt
// for keychain access. `adea-local-codesign` is a self-signed code-signing
// certificate created once per machine; signing with it keeps the identity
// (and therefore the grants) stable across rebuilds. CI keeps full control
// by exporting APPLE_SIGNING_IDENTITY itself.
function resolveSigningIdentity() {
  if (process.env.APPLE_SIGNING_IDENTITY) return process.env.APPLE_SIGNING_IDENTITY
  if (process.platform !== 'darwin') return undefined
  try {
    const { status, stdout } = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    })
    if (status === 0 && stdout.includes('"adea-local-codesign"')) {
      return 'adea-local-codesign'
    }
  } catch {
    // No security CLI or no identities: fall back to the bundler default.
  }
  return undefined
}

const signingIdentity = resolveSigningIdentity()

const environment = {
  ...process.env,
  ADEA_CLOUD_ORIGIN: cloudOrigin,
  VITE_ADEA_CLOUD_ORIGIN: cloudOrigin,
  ...(signingIdentity ? { APPLE_SIGNING_IDENTITY: signingIdentity } : {}),
}
const result = spawnSync(
  process.execPath,
  [
    'x',
    'tauri',
    command,
    ...arguments_,
    '--config',
    JSON.stringify(createTauriCloudConfig(cloudOrigin)),
  ],
  { env: environment, stdio: 'inherit' }
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
