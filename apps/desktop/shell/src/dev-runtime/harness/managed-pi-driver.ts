// Managed Pi driver (issue #31): the Agent HQ-owned installation lifecycle
// for the consumer zero-config path.
//
// Ownership boundary: the DEV RUNTIME does not manage Pi processes, prompts,
// compaction, or any model-facing loop. This driver owns exactly one thing —
// putting a verified, pinned managed Pi installation into an Agent HQ-owned
// location so a clean supported desktop reaches a healthy managed Pi
// RuntimeConnection with NO manual Pi installation required — and reporting
// that installation truthfully. A genuine host absence (unsupported host,
// missing bundled/cached archive, failed install) surfaces as the typed
// `capability_unavailable` contract error through the M10 gate; it is never
// masked with a fabricated session or a fake success.
//
// Version pinning is deterministic: the driver's pinned version and its
// archive digest are build-time constants, never resolved from the network.
// Runtime resolution order is "already installed at the pinned version" →
// "bundled/cached archive"; nothing else. Every install is digest-verified,
// written to a staging directory, and atomically renamed into place, so a
// failed install/update leaves the previous managed installation (and every
// user-managed Pi location, which is never touched) intact.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { nowIso, sameScope, type DevScope } from '../authority'
import type { AuthorityAudit } from '../audit'
import { createDurableJsonStore } from '../host-store'
import type {
  DevErrorCode,
  ManagedPiInstallState,
  ManagedPiStatus,
} from '../../../../../../packages/types/src/dev-runtime'

export const MANAGED_PI_DRIVER_ID = 'managed-pi'
export const MANAGED_PI_DRIVER_VERSION = '1'
export const MANAGED_PI_FAMILY = 'pi'

/**
 * The release-pinned managed Pi version. This constant — never a network
 * lookup — is the sole version authority for the managed lane; the archive
 * digest below is its verification anchor. The release pipeline publishes
 * both together (Runtime Compatibility Matrix records the combination).
 *
 * The digest here verifies the placeholder development payload
 * `adea-managed-pi-placeholder-archive-v1` so the install path is fully
 * exercised end to end; it is replaced by the real archive digest at
 * packaging time.
 */
export const MANAGED_PI_PINNED_VERSION = '0.1.42'
export const MANAGED_PI_PINNED_ARCHIVE_SHA256 =
  'ef66a8387630a518aaeb51ea168d58fa7420cba4eb51e1ee14bcf808e287fc9b'

export type ManagedPiDriverError = Readonly<{
  code: DevErrorCode
  retryable: boolean
  message: string
  /** Launch-time remediation hint carried verbatim through the gate. */
  remediation?: Readonly<{ action: string; parameters?: Readonly<Record<string, string>> }>
}>

export type ManagedPiHostProbe = Readonly<{
  supported: boolean
  reason?: string
}>

export type StoredManagedPi = Readonly<{
  scope: DevScope
  state: ManagedPiInstallState
  installationId?: string
  resolvedVersion?: string
  executableIdentity?: string
  executableLabel?: string
  lastErrorCode?: DevErrorCode
  lastError?: string
  generation: number
  observedAt: string
}>

export type ManagedPiDriverInput = {
  /** The verified local-lane scope; the managed installation binds to it. */
  scope: DevScope
  /** Owner-only data root; the install root stays under Agent HQ ownership. */
  dataDir: string
  audit?: AuthorityAudit
  now?: () => number
  /**
   * Content seam: resolves the pinned archive bytes, or null when neither a
   * bundled nor a cached archive exists. The production implementation never
   * hits the network when a cached archive is present; a cache miss without a
   * fetcher is a genuine unavailability, not a retry storm.
   */
  resolvePinnedArchive?: (version: string) => Promise<Uint8Array | null>
  /**
   * Host-support probe seam (platform/toolchain). Defaults to the packaged
   * support matrix; tests script it to simulate genuine host absence.
   */
  probeHost?: () => Promise<ManagedPiHostProbe>
  /** Overrides the install root (tests use a temp dir; default is under dataDir). */
  installRoot?: string
}

export type ManagedPiDriver = Readonly<{
  driverId: string
  driverVersion: string
  pinnedVersion: string
  /** Pure projection of the durable record. Never probes, never mutates. */
  status(): ManagedPiStatus
  /** Idempotent ensure: install-or-verify at the pinned version. */
  ensureInstalled(): Promise<ManagedPiStatus>
}>

function driverError(error: ManagedPiDriverError): ManagedPiDriverError {
  return error
}

function defaultProbeHost(): Promise<ManagedPiHostProbe> {
  // The packaged support matrix: the managed Pi lane ships for the desktop
  // platforms the shell builds for. The check stays synchronous on purpose —
  // platform support is a build fact, not a runtime observation.
  const supported = process.platform === 'darwin' || process.platform === 'linux'
  return Promise.resolve(
    supported
      ? { supported: true }
      : { supported: false, reason: `platform ${process.platform} has no managed Pi build` }
  )
}

export function createManagedPiDriver(input: ManagedPiDriverInput): ManagedPiDriver {
  const now = input.now ?? Date.now
  const installRoot =
    input.installRoot ?? join(input.dataDir, 'dev-runtime', 'harness', 'managed-pi')
  const store = createDurableJsonStore<StoredManagedPi>({
    file: join(input.dataDir, 'dev-runtime', 'harness', 'managed-pi.json'),
    schemaVersion: 1,
    label: 'managed Pi installation',
  })
  const resolvePinnedArchive = input.resolvePinnedArchive ?? (() => Promise.resolve(null))

  function load(): StoredManagedPi {
    const records = store.load().records
    const record = records[0]
    if (!record || !sameScope(record.scope, input.scope)) {
      return {
        scope: input.scope,
        state: 'absent',
        generation: 0,
        observedAt: nowIso(() => new Date(now())),
      }
    }
    return record
  }

  function save(record: StoredManagedPi): void {
    store.save([record])
  }

  function status(): ManagedPiStatus {
    const record = load()
    return {
      scope: record.scope,
      driverId: MANAGED_PI_DRIVER_ID,
      driverVersion: MANAGED_PI_DRIVER_VERSION,
      pinnedVersion: MANAGED_PI_PINNED_VERSION,
      state: record.state,
      ...(record.installationId !== undefined ? { installationId: record.installationId } : {}),
      ...(record.resolvedVersion !== undefined ? { resolvedVersion: record.resolvedVersion } : {}),
      ...(record.executableIdentity !== undefined
        ? { executableIdentity: record.executableIdentity }
        : {}),
      ...(record.executableLabel !== undefined ? { executableLabel: record.executableLabel } : {}),
      ...(record.lastErrorCode !== undefined ? { lastErrorCode: record.lastErrorCode } : {}),
      ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
      observedAt: record.observedAt,
      generation: record.generation,
    }
  }

  function fail(record: StoredManagedPi, error: ManagedPiDriverError): ManagedPiDriverError {
    save({
      ...record,
      // A failed install/update never degrades an already-ready managed
      // installation: the previous version stays usable (atomic-swap
      // rollback), so `ready` survives with the failure recorded.
      state: record.state === 'ready' ? 'ready' : 'failed',
      lastErrorCode: error.code,
      lastError: error.message.slice(0, 512),
      observedAt: nowIso(() => new Date(now())),
      generation: record.generation + 1,
    })
    input.audit?.append({
      action: 'harness.managedPi.install_failed',
      subjectId: input.scope.runtimeNodeId,
      outcome: 'failed',
      detail: { code: error.code },
    })
    return error
  }

  /**
   * Deterministic v5-shaped installation identity over the scope plus the
   * pinned version: the same managed installation keeps its ID across
   * rediscovery, and the ID never embeds a host path.
   */
  function installationId(): string {
    const raw = createHash('sha1')
      .update('adea-m10-31-managed-pi-installation')
      .update('\0')
      .update(
        `${input.scope.accountId}\0${input.scope.workspaceId}\0${input.scope.runtimeNodeId}\0${MANAGED_PI_PINNED_VERSION}`
      )
      .digest()
    raw[6] = (raw[6]! & 0x0f) | 0x50
    raw[8] = (raw[8]! & 0x3f) | 0x80
    const hex = raw.subarray(0, 16).toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  }

  async function ensureInstalled(): Promise<ManagedPiStatus> {
    const record = load()
    // Cached-and-current is the steady state: no writes, no probing, no
    // network — the pinned resolution is entirely local and deterministic.
    if (record.state === 'ready' && record.resolvedVersion === MANAGED_PI_PINNED_VERSION) {
      return status()
    }

    const probe = await (input.probeHost ?? defaultProbeHost)()
    if (!probe.supported) {
      throw fail(
        record,
        driverError({
          code: 'capability_unavailable',
          retryable: false,
          message: probe.reason ?? 'this host cannot run the managed Pi installation',
          remediation: { action: 'managedPi.status' },
        })
      )
    }

    let archive: Uint8Array | null
    try {
      archive = await resolvePinnedArchive(MANAGED_PI_PINNED_VERSION)
    } catch (error) {
      throw fail(
        record,
        driverError({
          code: 'capability_unavailable',
          retryable: true,
          message: `the pinned managed Pi archive could not be resolved: ${
            error instanceof Error ? error.message : 'resolver failed'
          }`,
          remediation: { action: 'managedPi.install.retry' },
        })
      )
    }
    if (!archive || archive.byteLength === 0) {
      throw fail(
        record,
        driverError({
          code: 'capability_unavailable',
          retryable: true,
          message:
            'no bundled or cached managed Pi archive is available for the pinned version on this host',
          remediation: { action: 'managedPi.install.retry' },
        })
      )
    }

    // Pin verification: the archive must hash to the build-time digest. A
    // mismatch refuses before any byte reaches the install root.
    const digest = createHash('sha256').update(archive).digest('hex')
    if (digest !== MANAGED_PI_PINNED_ARCHIVE_SHA256) {
      throw fail(
        record,
        driverError({
          code: 'corrupt_state',
          retryable: false,
          message: 'the resolved managed Pi archive does not match its pinned digest',
        })
      )
    }

    const staging = join(installRoot, `.staging-${process.pid}-${randomBytes(4).toString('hex')}`)
    const target = join(installRoot, MANAGED_PI_PINNED_VERSION)
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      writeFileSync(join(staging, 'pi'), archive, { mode: 0o700 })
      writeFileSync(
        join(staging, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          driverId: MANAGED_PI_DRIVER_ID,
          driverVersion: MANAGED_PI_DRIVER_VERSION,
          provenance: 'managed',
          version: MANAGED_PI_PINNED_VERSION,
          archiveSha256: digest,
          installedAt: nowIso(() => new Date(now())),
        })
      )
      mkdirSync(installRoot, { recursive: true, mode: 0o700 })
      // Atomic swap: a previous managed version is rotated aside and removed
      // only after the new one is in place. User-managed Pi locations are
      // never read or written.
      const previous = join(installRoot, `.previous-${randomBytes(4).toString('hex')}`)
      if (existsSync(target)) renameSync(target, previous)
      renameSync(staging, target)
      if (existsSync(previous)) rmSync(previous, { recursive: true, force: true })
      for (const entry of readdirSync(installRoot)) {
        if (entry.startsWith('.staging-')) {
          rmSync(join(installRoot, entry), { recursive: true, force: true })
        }
      }
    } catch (error) {
      // Rollback: drop staging and restore the rotated-aside installation if
      // the swap lost it, so the previous managed version keeps serving.
      rmSync(staging, { recursive: true, force: true })
      const previous = readdirSync(installRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('.previous-'))
        .map((entry) => entry.name)
      for (const name of previous) {
        const path = join(installRoot, name)
        if (!existsSync(target)) renameSync(path, target)
        else rmSync(path, { recursive: true, force: true })
      }
      throw fail(
        record,
        driverError({
          code: 'unavailable',
          retryable: true,
          message: `the managed Pi installation could not be written: ${
            error instanceof Error ? error.message : 'filesystem failure'
          }`,
          remediation: { action: 'managedPi.install.retry' },
        })
      )
    }

    const executableIdentity = join(target, 'pi')
    const ready: StoredManagedPi = {
      scope: input.scope,
      state: 'ready',
      installationId: record.installationId ?? installationId(),
      resolvedVersion: MANAGED_PI_PINNED_VERSION,
      executableIdentity,
      executableLabel: `managed Pi ${MANAGED_PI_PINNED_VERSION}`,
      generation: record.generation + 1,
      observedAt: nowIso(() => new Date(now())),
    }
    save(ready)
    input.audit?.append({
      action: 'harness.managedPi.installed',
      subjectId: ready.installationId ?? input.scope.runtimeNodeId,
      outcome: 'granted',
      detail: { version: MANAGED_PI_PINNED_VERSION, sha256: digest },
    })
    return status()
  }

  return Object.freeze({
    driverId: MANAGED_PI_DRIVER_ID,
    driverVersion: MANAGED_PI_DRIVER_VERSION,
    pinnedVersion: MANAGED_PI_PINNED_VERSION,
    status,
    ensureInstalled,
  })
}
