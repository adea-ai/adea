// The transitional device key: one random 256-bit AES key under the app data
// directory's `desktop-state/device.key` (owner-only). The command surface's
// sealed state and the local content store both encrypt under it; see
// docs/specs/local-content.md ("Current implementation and target limits")
// for the documented gap against the OS keyring target.
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Reads the device key, minting it on first use. */
export function loadDeviceKey(keyFile: string): Buffer {
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 })
    chmodSync(keyFile, 0o600)
  }
  return readFileSync(keyFile)
}
