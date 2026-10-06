// The shell terminal lane's sidecar plan (issue #396): the typed handoff
// between the packaging lane's install-location resolution and the boot
// adoption seam. A packaged boot runs the BUNDLED sidecar — the packaged
// entry executed by the bundled Bun runtime, spawned through the supervision
// engine's process adapter so the launch journal records it (#185) — and a
// repo dev run keeps the dev fallback: the source-tree entry on the repo
// toolchain. A packaged boot never falls back to a dev spawn: if the
// packaged command cannot be resolved the lane stays typed-unavailable.
//
// #1039: the dev variant declares its spawn facts (argv, environment key
// names, cwd) and returns the child handle, so the boot seam can journal the
// spawn and its exit into the boot-adoption journal — a boot whose sidecar
// dies before publishing names its failing step from durable facts.
import { join } from 'node:path'

import type { SpawnFacts } from '../supervision/boot-diagnostics'
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
      /** The spawn this plan would perform for a data dir: the facts the
       *  boot seam journals (values are the plan's affair; the journal
       *  records argv, environment KEY NAMES only, and cwd). */
      spawnFacts: (dataDir: string) => SpawnFacts
      /** Starts the dev-fallback sidecar for this data dir and returns the
       *  child handle (the boot seam journals the child's fate). */
      start: (dataDir: string) => Bun.Subprocess | undefined
    }>

/** The packaged plan: the spawn is the engine's, the identity the packaging
 *  lane's declared sidecar identity. */
export function packagedSidecarPlan(executableIdentity: string): ShellSidecarPlan {
  return { mode: 'packaged', executableIdentity }
}

/** The dev fallback's spawn: the source-tree entry on the repo toolchain in
 *  a positive-allowlist environment (never the shell's inherited whole).
 *  Shared by the plan's `spawnFacts` (what the seam journals) and `start`
 *  (what it executes) so the record and the process cannot drift. */
function devSpawn(dataDir: string): { argv: string[]; env: Record<string, string> } {
  const argv = [process.execPath, DEV_SIDECAR_ENTRY, '--data-dir', dataDir]
  const env = buildComponentEnv(process.env as Record<string, string | undefined>, {
    ADEA_SIDECAR_VERSION: 'dev',
    ADEA_SIDECAR_IDENTITY: DEV_SIDECAR_IDENTITY,
  })
  return { argv, env }
}

/** The dev fallback plan: the source-tree entry on the repo toolchain. */
export function devSidecarPlan(): ShellSidecarPlan {
  return {
    mode: 'dev',
    executableIdentity: DEV_SIDECAR_IDENTITY,
    spawnFacts: (dataDir) => {
      const { argv, env } = devSpawn(dataDir)
      return { argv, envKeys: Object.keys(env), cwd: null }
    },
    start: (dataDir) => {
      const { argv, env } = devSpawn(dataDir)
      return Bun.spawn(argv, {
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
    },
  }
}
