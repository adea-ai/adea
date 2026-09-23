// Managed Pi driver (issue #31): the Agent HQ-owned installation lifecycle
// for the consumer zero-config path.
//
// Ownership boundary: the DEV RUNTIME does not manage Pi processes, prompts,
// compaction, or any model-facing loop. This driver owns exactly one thing —
// putting a verified, pinned managed Pi installation into an Agent HQ-owned
// location so a clean supported desktop reaches a healthy managed Pi
// RuntimeConnection with NO manual Pi installation required — and reporting
// that installation truthfully. A genuine host absence (unsupported host,
// missing source, network refusal, failed install) surfaces as the typed
// `capability_unavailable`/`unavailable` contract error through the M10 gate;
// it is never masked with a fabricated session or a fake success.
//
// Version pinning is deterministic: the driver's pinned version, its archive
// digest, and the release URL are build-time constants, never resolved from
// the network. The URL embeds the exact pinned version — the driver never
// asks a server "what is latest". Source resolution order is strictly:
// "already installed at the pinned version" → bundled archive (packaged app
// dir) → data-dir cache → one bounded fetch of the pinned URL. A successful
// download is persisted into the cache after digest verification, so the
// cache holds only verified pinned archives and a re-ensure never refetches.
// Every source declares the version it serves; a source whose
// declared version differs from the pin is a typed version-drift refusal
// (`incompatible`) before any byte is trusted, and the digest check remains
// the final verification anchor. Every install is digest-verified, written to
// a staging directory, and atomically renamed into place, so a failed
// install/update leaves the previous managed installation (and every
// user-managed Pi location, which is never touched) intact.
//
// The driver never breaks the shell boot: construction is synchronous and
// non-throwing, every `ensureInstalled` failure is typed, concurrent calls
// share one in-flight install (single-flight), and the composition-level warm
// is fire-and-forget (see the Dev Runtime host composition).
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import { nowIso, sameScope, type DevScope } from '../authority'
import type { AuthorityAudit } from '../audit'
import { createDurableJsonStore } from '../host-store'
import { compareVersions } from '../discovery/probe'
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
 * digest and release URL below are published together with it by the release
 * pipeline (the Runtime Compatibility Matrix records the combination).
 *
 * The digest here verifies the placeholder development payload
 * `adea-managed-pi-placeholder-archive-v1` so the install path is fully
 * exercised end to end; the URL points at the pinned placeholder release.
 * The packaging step replaces version, digest, and URL together.
 */
export const MANAGED_PI_PINNED_VERSION = '0.1.42'
export const MANAGED_PI_PINNED_ARCHIVE_SHA256 =
  'ef66a8387630a518aaeb51ea168d58fa7420cba4eb51e1ee14bcf808e287fc9b'
const PINNED_ARCHIVE_FILE_NAME = `managed-pi-${MANAGED_PI_PINNED_VERSION}.archive`
export const MANAGED_PI_PINNED_ARCHIVE_URL = `https://releases.adea.ai/managed-pi/${MANAGED_PI_PINNED_VERSION}/${PINNED_ARCHIVE_FILE_NAME}`

/** The download is hard-capped: a source serving more is refused, never ingested. */
export const MANAGED_PI_ARCHIVE_MAX_BYTES = 1_073_741_824
/** One bounded download deadline; an exceeded deadline is a typed `timeout`. */
export const MANAGED_PI_DOWNLOAD_TIMEOUT_MS = 120_000
/**
 * The shell runs the Electrobun-bundled Bun runtime (adea#490 discipline):
 * the network fetch path refuses to run on a runtime older than the version
 * the desktop lane is built and tested against, with a typed `incompatible`.
 * Bundled and cached sources still install on any runtime.
 */
export const MANAGED_PI_MIN_RUNTIME_VERSION = '1.4.0'
/** The on-disk install manifest is bounded; anything larger is drift. */
const INSTALL_MANIFEST_MAX_BYTES = 65_536

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

/** Where the verified archive bytes came from; recorded as install provenance. */
export type ManagedPiArchiveOrigin = 'bundled' | 'cache' | 'network' | 'override'

export type ManagedPiArchiveSource = Readonly<{
  bytes: Uint8Array
  origin: ManagedPiArchiveOrigin
  /**
   * The version the source declares it serves. The pinned file names, the
   * pinned URL segment, and an injected test resolver all declare the pin by
   * construction; a mismatch is a typed version-drift refusal.
   */
  declaredVersion: string
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
   * Overrides the whole source chain (tests script archives; a packaged lane
   * may pin a fully offline source). Return the pinned bytes, or null when no
   * source exists. The result still passes digest verification — the override
   * replaces the resolution order, never the pin verification.
   */
  resolvePinnedArchive?: (version: string) => Promise<Uint8Array | null>
  /**
   * Network transport for the pinned-URL fetch. Defaults to the global
   * `fetch`; tests script refusals, non-OK statuses, and wrong bytes.
   */
  fetchImpl?: typeof fetch
  /**
   * Host-support probe seam (platform/toolchain). Defaults to the packaged
   * support matrix; tests script it to simulate genuine host absence.
   */
  probeHost?: () => Promise<ManagedPiHostProbe>
  /**
   * The Bun runtime version the download guard evaluates. Defaults to
   * `process.versions.bun`; tests script old/unknown runtimes.
   */
  runtimeVersion?: () => string | undefined
  /**
   * The directory holding the packaged bundled archive
   * (`managed-pi/<version>.archive`). Defaults to the packaged app dir when
   * the driver runs from inside an `.app` bundle, else no bundled source.
   */
  bundledResourcesDir?: string | null
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

/**
 * Carries the version-drift context into a heal failure: the record already
 * claimed `ready` for an installation that stopped matching the pin, so the
 * surfaced error must name the drift, whatever the underlying cause was.
 */
function asDrift(error: ManagedPiDriverError, driftDetected: boolean): ManagedPiDriverError {
  if (!driftDetected) return error
  return driverError({
    ...error,
    message: `the managed installation on disk no longer matches the pinned ${MANAGED_PI_PINNED_VERSION}: ${error.message}`,
  })
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

function defaultRuntimeVersion(): string | undefined {
  const versions = (process as { versions?: { bun?: string } }).versions
  return versions?.bun
}

/**
 * The packaged bundled-archive root: the app dir inside a running `.app`
 * bundle (the same arithmetic the packaged manifest load uses — the bundled
 * file goes one `managed-pi/` directory below it). Null outside a bundle, so
 * dev runs and tests deterministically have no bundled source.
 */
function defaultBundledResourcesDir(): string | null {
  try {
    const bundleRoot = resolve(import.meta.dir, '..', '..', '..')
    if (!bundleRoot.endsWith('.app')) return null
    return join(bundleRoot, 'Contents', 'Resources', 'app')
  } catch {
    return null
  }
}

/** Reads a bounded file, or null when it does not exist or exceeds the cap. */
function readBoundedOrNull(path: string, maxBytes: number): Uint8Array | null {
  try {
    if (!existsSync(path)) return null
    const bytes = readFileSync(path)
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null
    return new Uint8Array(bytes)
  } catch {
    return null
  }
}

/**
 * Reads the installed manifest's version for the cache-hit self-check, or
 * null when the manifest is missing, unreadable, oversized, or not JSON with
 * a string version — every such outcome is version drift, never a false
 * "verified".
 */
function installedManifestVersion(installDir: string): string | null {
  const raw = readBoundedOrNull(join(installDir, 'manifest.json'), INSTALL_MANIFEST_MAX_BYTES)
  if (!raw) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

export function createManagedPiDriver(input: ManagedPiDriverInput): ManagedPiDriver {
  const now = input.now ?? Date.now
  const installRoot =
    input.installRoot ?? join(input.dataDir, 'dev-runtime', 'harness', 'managed-pi')
  const cacheRoot = join(installRoot, 'cache')
  const store = createDurableJsonStore<StoredManagedPi>({
    file: join(input.dataDir, 'dev-runtime', 'harness', 'managed-pi.json'),
    schemaVersion: 1,
    label: 'managed Pi installation',
  })
  const fetchImpl = input.fetchImpl ?? fetch
  const runtimeVersion = input.runtimeVersion ?? defaultRuntimeVersion
  const bundledResourcesDir =
    input.bundledResourcesDir === undefined
      ? defaultBundledResourcesDir()
      : input.bundledResourcesDir

  /** Single-flight: concurrent ensures (boot warm + explicit command) share
   * one run; a second caller receives the first's outcome, never a second
   * concurrent install. */
  let inFlight: Promise<ManagedPiStatus> | undefined

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

  function fail(
    record: StoredManagedPi,
    error: ManagedPiDriverError,
    forceFailureState = false
  ): ManagedPiDriverError {
    save({
      ...record,
      // A failed install/update never degrades an already-ready managed
      // installation: the previous version stays usable (atomic-swap
      // rollback), so `ready` survives with the failure recorded — EXCEPT
      // version drift, where the on-disk artifact itself stopped matching
      // the pin and the ready claim would be a lie.
      state: !forceFailureState && record.state === 'ready' ? 'ready' : 'failed',
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

  // ── Source resolution: bundled → cache → one bounded pinned fetch ────────

  function sourceFor(origin: ManagedPiArchiveOrigin, path: string): ManagedPiArchiveSource | null {
    const bytes = readBoundedOrNull(path, MANAGED_PI_ARCHIVE_MAX_BYTES)
    if (!bytes) return null
    return { bytes, origin, declaredVersion: MANAGED_PI_PINNED_VERSION }
  }

  /**
   * Persists downloaded bytes into the data-dir cache (atomic rename, owner
   * modes) so later ensures never refetch. Best-effort: a cache-write failure
   * never fails the install — the bytes are already in memory and verified.
   */
  function persistToCache(bytes: Uint8Array): void {
    try {
      mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
      const temporary = join(cacheRoot, `.${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
      writeFileSync(temporary, bytes, { mode: 0o600 })
      renameSync(temporary, join(cacheRoot, PINNED_ARCHIVE_FILE_NAME))
    } catch {
      // The cache is an optimization, never a correctness dependency.
    }
  }

  /**
   * Fetches the pinned release URL once, under a deadline and a hard size
   * cap. Every failure mode is typed and leaves nothing on disk.
   */
  async function fetchPinnedArchive(): Promise<ManagedPiArchiveSource> {
    // Bun runtime-version guard (adea#490): the fetch path refuses on a
    // runtime older than the desktop lane's floor; bundled/cached sources
    // still install. Unknown runtimes refuse the same way.
    const observed = runtimeVersion()
    if (!observed || compareVersions(observed, MANAGED_PI_MIN_RUNTIME_VERSION) < 0) {
      throw driverError({
        code: 'incompatible',
        retryable: false,
        message: `the Bun runtime ${
          observed ?? 'version is unknown'
        } cannot fetch the managed Pi archive; ${MANAGED_PI_MIN_RUNTIME_VERSION} or newer is required, while bundled or cached archives still install`,
      })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MANAGED_PI_DOWNLOAD_TIMEOUT_MS)
    timer.unref?.()
    let response: Response
    try {
      response = await fetchImpl(MANAGED_PI_PINNED_ARCHIVE_URL, {
        redirect: 'follow',
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw driverError({
          code: 'timeout',
          retryable: true,
          message: `the managed Pi archive fetch exceeded ${MANAGED_PI_DOWNLOAD_TIMEOUT_MS}ms`,
          remediation: { action: 'managedPi.install.retry' },
        })
      }
      throw driverError({
        code: 'unavailable',
        retryable: true,
        message: `the managed Pi archive could not be fetched from the pinned release URL: ${
          error instanceof Error ? error.message : 'network refused'
        }`,
        remediation: { action: 'managedPi.install.retry' },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw driverError({
        code: 'remote_unavailable',
        retryable: true,
        message: `the pinned managed Pi release endpoint answered ${response.status}; it is not serving the pinned version yet`,
        remediation: { action: 'managedPi.install.retry' },
      })
    }
    const reader = response.body?.getReader()
    if (!reader) {
      throw driverError({
        code: 'unavailable',
        retryable: true,
        message: 'the pinned managed Pi release endpoint served no archive bytes',
        remediation: { action: 'managedPi.install.retry' },
      })
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MANAGED_PI_ARCHIVE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw driverError({
          code: 'limit_exceeded',
          retryable: false,
          message: `the pinned managed Pi archive exceeds the ${MANAGED_PI_ARCHIVE_MAX_BYTES}-byte cap`,
        })
      }
      chunks.push(value)
    }
    if (total === 0) {
      throw driverError({
        code: 'unavailable',
        retryable: true,
        message: 'the pinned managed Pi release endpoint served an empty archive',
        remediation: { action: 'managedPi.install.retry' },
      })
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, origin: 'network', declaredVersion: MANAGED_PI_PINNED_VERSION }
  }

  /** The production source chain. Never throws: every failure is a typed
   * value so `ensureInstalled` records it through one path. */
  async function resolveSourceFromHost(): Promise<ManagedPiArchiveSource | null> {
    if (bundledResourcesDir) {
      const bundled = sourceFor(
        'bundled',
        join(bundledResourcesDir, 'managed-pi', PINNED_ARCHIVE_FILE_NAME)
      )
      if (bundled) return bundled
    }
    const cached = sourceFor('cache', join(cacheRoot, PINNED_ARCHIVE_FILE_NAME))
    if (cached) return cached
    return fetchPinnedArchive()
  }

  /** The drift self-check: a ready record is only a cache-hit when the
   * on-disk installation still declares the pinned version. */
  function installationMatchesPin(): boolean {
    const target = join(installRoot, MANAGED_PI_PINNED_VERSION)
    if (!existsSync(join(target, 'pi'))) return false
    return installedManifestVersion(target) === MANAGED_PI_PINNED_VERSION
  }

  async function runEnsure(): Promise<ManagedPiStatus> {
    const record = load()
    // Cached-and-current is the steady state: no writes, no probing, no
    // network — the pinned resolution is entirely local and deterministic.
    // The record alone is not trusted: the on-disk installation must still
    // declare the pinned version. A mismatch is version drift: the ensure
    // heals by reinstalling, and every heal failure is reported as drift
    // (the ready claim is no longer trustworthy, so the record never keeps
    // claiming `ready` through a failed heal).
    let driftDetected = false
    if (record.state === 'ready' && record.resolvedVersion === MANAGED_PI_PINNED_VERSION) {
      if (installationMatchesPin()) return status()
      driftDetected = true
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

    let source: ManagedPiArchiveSource | null
    try {
      source = input.resolvePinnedArchive
        ? await (async (): Promise<ManagedPiArchiveSource | null> => {
            // An injected resolver replaces the chain (build/test wiring), not
            // the pin: it declares the pinned version by construction and the
            // digest below still verifies every byte.
            const bytes = await input.resolvePinnedArchive!(MANAGED_PI_PINNED_VERSION)
            if (!bytes || bytes.byteLength === 0) return null
            return { bytes, origin: 'override', declaredVersion: MANAGED_PI_PINNED_VERSION }
          })()
        : await resolveSourceFromHost()
    } catch (error) {
      // The default chain throws typed ManagedPiDriverError values; re-record
      // them through the single failure path. Anything else is a resolver bug
      // surfaced as typed unavailability, never a raw crash.
      const typed = error as Partial<ManagedPiDriverError>
      if (
        typed &&
        typeof typed.code === 'string' &&
        typeof typed.retryable === 'boolean' &&
        typeof typed.message === 'string'
      ) {
        throw fail(record, asDrift(typed as ManagedPiDriverError, driftDetected), true)
      }
      throw fail(
        record,
        asDrift(
          driverError({
            code: 'capability_unavailable',
            retryable: true,
            message: `the pinned managed Pi archive could not be resolved: ${
              error instanceof Error ? error.message : 'resolver failed'
            }`,
            remediation: { action: 'managedPi.install.retry' },
          }),
          driftDetected
        )
      )
    }
    if (!source) {
      throw fail(
        record,
        driftDetected
          ? driverError({
              code: 'incompatible',
              retryable: true,
              message: `the managed installation on disk no longer matches the pinned ${MANAGED_PI_PINNED_VERSION} and no verified source is available to heal it`,
              remediation: { action: 'managedPi.install.retry' },
            })
          : driverError({
              code: 'capability_unavailable',
              retryable: true,
              message:
                'no bundled or cached managed Pi archive is available for the pinned version on this host',
              remediation: { action: 'managedPi.install.retry' },
            }),
        true
      )
    }

    // Version drift: a source declaring another version never installs under
    // the pin's name. This is a supply-chain shape check that runs before the
    // digest work, so drifted bytes are diagnosed as drift, not corruption.
    if (source.declaredVersion !== MANAGED_PI_PINNED_VERSION) {
      throw fail(
        record,
        asDrift(
          driverError({
            code: 'incompatible',
            retryable: false,
            message: `the resolved managed Pi source declares version ${source.declaredVersion}, not the pinned ${MANAGED_PI_PINNED_VERSION}`,
          }),
          driftDetected
        ),
        true
      )
    }

    // Pin verification: the archive must hash to the build-time digest. A
    // mismatch refuses before any byte reaches the install root — and before
    // the cache: the cache holds only digest-verified pinned archives, so a
    // corrupted download leaves nothing behind and the next ensure refetches.
    const digest = createHash('sha256').update(source.bytes).digest('hex')
    if (digest !== MANAGED_PI_PINNED_ARCHIVE_SHA256) {
      throw fail(
        record,
        asDrift(
          driverError({
            code: 'corrupt_state',
            retryable: false,
            message: 'the resolved managed Pi archive does not match its pinned digest',
          }),
          driftDetected
        ),
        true
      )
    }
    if (source.origin === 'network') persistToCache(source.bytes)

    const staging = join(installRoot, `.staging-${process.pid}-${randomBytes(4).toString('hex')}`)
    const target = join(installRoot, MANAGED_PI_PINNED_VERSION)
    try {
      mkdirSync(staging, { recursive: true, mode: 0o700 })
      writeFileSync(join(staging, 'pi'), source.bytes, { mode: 0o700 })
      writeFileSync(
        join(staging, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          driverId: MANAGED_PI_DRIVER_ID,
          driverVersion: MANAGED_PI_DRIVER_VERSION,
          provenance: 'managed',
          version: MANAGED_PI_PINNED_VERSION,
          archiveSha256: digest,
          sourceOrigin: source.origin,
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
      //
      // Every step here is best-effort, and it has to be: the failure that got
      // us here is usually the filesystem (disk pressure, a read-only or
      // non-directory install root), which is exactly when cleanup calls fail
      // too. A cleanup that threw would mask the typed retryable failure and
      // skip the restore, which is the #185 failure-atomicity contract.
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {
        // staging was never fully created, or the root is not writable
      }
      try {
        const previous = readdirSync(installRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('.previous-'))
          .map((entry) => entry.name)
        for (const name of previous) {
          const path = join(installRoot, name)
          if (!existsSync(target)) renameSync(path, target)
          else rmSync(path, { recursive: true, force: true })
        }
      } catch {
        // The previous installation could not be restored; the typed failure
        // below still reports the install as retryable.
      }
      throw fail(
        record,
        asDrift(
          driverError({
            code: 'unavailable',
            retryable: true,
            message: `the managed Pi installation could not be written: ${
              error instanceof Error ? error.message : 'filesystem failure'
            }`,
            remediation: { action: 'managedPi.install.retry' },
          }),
          driftDetected
        ),
        driftDetected
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

  function ensureInstalled(): Promise<ManagedPiStatus> {
    if (inFlight) return inFlight
    inFlight = runEnsure().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  return Object.freeze({
    driverId: MANAGED_PI_DRIVER_ID,
    driverVersion: MANAGED_PI_DRIVER_VERSION,
    pinnedVersion: MANAGED_PI_PINNED_VERSION,
    status,
    ensureInstalled,
  })
}
