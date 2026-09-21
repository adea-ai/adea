// The shell terminal lane's sidecar plan (issue #396): the typed handoff
// between the packaging lane's install-location resolution and the boot
// adoption seam. A packaged boot runs the BUNDLED sidecar — the packaged
// entry executed by the bundled Bun runtime, spawned through the supervision
// engine's process adapter so the launch journal records it (#185) — and a
// repo dev run keeps the dev fallback: the source-tree entry on the repo
// toolchain. A packaged boot never falls back to a dev spawn: if the
// packaged command cannot be resolved the lane stays typed-unavailable.
import { join } from 'node:path'

import { buildComponentEnv } from '../supervision/process-adapter'

/** The endpoint executable identity of a dev-run source-tree sidecar (the
 *  sidecar entry derives it from `ADEA_SIDECAR_IDENTITY`). */
export const DEV_SIDECAR_IDENTITY = 'adea-terminal-sidecar@dev'

/** The dev fallback's entry: the same source the packaged sidecar is bundled
 *  from (mirrors the supervision smoke's dev-fallback mode). */
export const DEV_SIDECAR_ENTRY = join(import.meta.dir, '../dev-runtime/terminal/sidecar/entry.ts')

export type ShellSidecarPlan =
  | Readonly<{
      mode: 'packaged'
      /** The packaging lane's declared sidecar identity; the endpoint must
       *  present exactly it to be adoptable. The spawn itself belongs to the
       *  supervision engine's process adapter, never to this seam. */
      executableIdentity: string
    }>
  | Readonly<{
      mode: 'dev'
      executableIdentity: string
      /** Starts the dev-fallback sidecar for this data dir. */
      start: (dataDir: string) => void
    }>

/** The packaged plan: the spawn is the engine's, the identity the packaging
 *  lane's declared sidecar identity. */
export function packagedSidecarPlan(executableIdentity: string): ShellSidecarPlan {
  return { mode: 'packaged', executableIdentity }
}

/** The dev fallback plan: the source-tree entry on the repo toolchain, in a
 *  positive-allowlist environment (never the shell's inherited whole). */
export function devSidecarPlan(): ShellSidecarPlan {
  return {
    mode: 'dev',
    executableIdentity: DEV_SIDECAR_IDENTITY,
    start: (dataDir) => {
      Bun.spawn([process.execPath, DEV_SIDECAR_ENTRY, '--data-dir', dataDir], {
        env: buildComponentEnv(process.env as Record<string, string | undefined>, {
          ADEA_SIDECAR_VERSION: 'dev',
          ADEA_SIDECAR_IDENTITY: DEV_SIDECAR_IDENTITY,
        }),
        stdout: 'ignore',
        stderr: 'ignore',
      })
    },
  }
}
