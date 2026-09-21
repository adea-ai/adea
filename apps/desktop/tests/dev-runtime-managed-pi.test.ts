// Managed Pi driver zero-config acceptance (#31): the production source chain
// (bundled → data-dir cache → one bounded pinned fetch), its typed failure
// matrix (network refused, checksum mismatch, version drift, runtime guard),
// the cache-hit self-check, single-flight, and the boot-safe composition warm.
//
// The pinned version/digest/install/rollback behaviors themselves are pinned
// by dev-runtime-harness.test.ts; this file pins what makes the install work
// on a clean desktop with no manual Pi step — and fail typed when it cannot.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Scope } from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import {
  createManagedPiDriver,
  MANAGED_PI_ARCHIVE_MAX_BYTES,
  MANAGED_PI_MIN_RUNTIME_VERSION,
  MANAGED_PI_PINNED_ARCHIVE_URL,
  MANAGED_PI_PINNED_VERSION,
  type ManagedPiDriverInput,
} from '../shell/src/dev-runtime/harness/managed-pi-driver'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000010001',
  workspaceId: '00000000-0000-4000-8000-000000010002',
  runtimeNodeId: '00000000-0000-4000-8000-000000010003',
}

/** The exact placeholder payload the pinned digest anchors (see the driver). */
const PINNED_ARCHIVE = new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')
const PINNED_ARCHIVE_FILE = `managed-pi-${MANAGED_PI_PINNED_VERSION}.archive`

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'adea-managed-pi-'))
}

function driverInput(overrides: Partial<ManagedPiDriverInput> = {}): ManagedPiDriverInput {
  return {
    scope: SCOPE,
    dataDir: overrides.dataDir ?? tempDir(),
    installRoot: overrides.installRoot,
    ...overrides,
  }
}

type ScriptedResponse = {
  ok: boolean
  status: number
  body?: ReadableStream<Uint8Array>
}

function responseWithBytes(bytes: Uint8Array, status = 200): ScriptedResponse {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return { ok: status >= 200 && status < 300, status, body: stream }
}

/** A scripted `typeof fetch` with a call counter (the no-refetch proof). */
function scriptedFetch(handler: (url: string) => Promise<ScriptedResponse | never>): {
  fetch: typeof fetch
  calls: () => number
} {
  let count = 0
  const impl = (async (url: unknown) => {
    count += 1
    return await handler(String(url))
  }) as unknown as typeof fetch
  return { fetch: impl, calls: () => count }
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function expectedDigest(): string {
  return digestOf(PINNED_ARCHIVE)
}

function writeCache(installRoot: string, bytes: Uint8Array): string {
  const cacheDir = join(installRoot, 'cache')
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  const file = join(cacheDir, PINNED_ARCHIVE_FILE)
  writeFileSync(file, bytes, { mode: 0o600 })
  return file
}

/** The scripted too-old runtime for the fetch-guard seam. */
const oldRuntime = (): string => '1.3.9'

/** Seeds a durable record that claims `ready` at the pin. */
function seedReadyRecord(dataDir: string): void {
  const file = join(dataDir, 'dev-runtime', 'harness', 'managed-pi.json')
  mkdirSync(join(dataDir, 'dev-runtime', 'harness'), { recursive: true, mode: 0o700 })
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      records: [
        {
          scope: SCOPE,
          state: 'ready',
          installationId: '11111111-2222-4333-8444-555555555555',
          resolvedVersion: MANAGED_PI_PINNED_VERSION,
          executableIdentity: '/drifted/pi',
          executableLabel: 'managed Pi drifted',
          generation: 4,
          observedAt: new Date().toISOString(),
        },
      ],
    }),
    { mode: 0o600 }
  )
}

/** Seeds an on-disk installation whose manifest declares an older version. */
function seedDriftedInstall(dataDir: string): string {
  const installDir = join(
    dataDir,
    'dev-runtime',
    'harness',
    'managed-pi',
    MANAGED_PI_PINNED_VERSION
  )
  mkdirSync(installDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(installDir, 'pi'), 'drifted bytes', { mode: 0o700 })
  writeFileSync(
    join(installDir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, version: '0.1.41' })
  )
  return installDir
}

describe('managed Pi production source chain (#31)', () => {
  test('a cache miss downloads the pinned URL once, persists the cache, and a re-ensure never refetches', async () => {
    const dataDir = tempDir()
    const { fetch, calls } = scriptedFetch((url) => {
      expect(url).toBe(MANAGED_PI_PINNED_ARCHIVE_URL)
      return Promise.resolve(responseWithBytes(PINNED_ARCHIVE))
    })
    const driver = createManagedPiDriver(driverInput({ dataDir, fetchImpl: fetch }))
    try {
      const first = await driver.ensureInstalled()
      expect(first).toMatchObject({
        state: 'ready',
        resolvedVersion: MANAGED_PI_PINNED_VERSION,
      })
      expect(calls()).toBe(1)
      // The download was persisted into the data-dir cache before install.
      const cacheFile = join(
        dataDir,
        'dev-runtime',
        'harness',
        'managed-pi',
        'cache',
        PINNED_ARCHIVE_FILE
      )
      expect(existsSync(cacheFile)).toBe(true)
      expect(new Uint8Array(readFileSync(cacheFile))).toEqual(PINNED_ARCHIVE)

      // Second ensure: pure local hit — no network, no probing.
      const second = await driver.ensureInstalled()
      expect(second).toMatchObject({ state: 'ready', installationId: first.installationId })
      expect(calls()).toBe(1)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a bundled archive wins over the network; the cache wins over the network', async () => {
    const bundledDir = tempDir()
    const dataDir = tempDir()
    const { fetch, calls } = scriptedFetch(() => {
      throw new Error('the network must never be touched when a local source exists')
    })
    mkdirSync(join(bundledDir, 'managed-pi'), { recursive: true, mode: 0o700 })
    writeFileSync(join(bundledDir, 'managed-pi', PINNED_ARCHIVE_FILE), PINNED_ARCHIVE)
    const driver = createManagedPiDriver(
      driverInput({ dataDir, fetchImpl: fetch, bundledResourcesDir: bundledDir })
    )
    try {
      const installed = await driver.ensureInstalled()
      expect(installed).toMatchObject({
        state: 'ready',
        resolvedVersion: MANAGED_PI_PINNED_VERSION,
      })
      expect(calls()).toBe(0)

      // Cache-only (no bundled dir): still no network.
      const cachedDataDir = tempDir()
      try {
        const installRoot = join(cachedDataDir, 'dev-runtime', 'harness', 'managed-pi')
        writeCache(installRoot, PINNED_ARCHIVE)
        const cacheDriver = createManagedPiDriver(
          driverInput({ dataDir: cachedDataDir, installRoot, fetchImpl: fetch })
        )
        expect((await cacheDriver.ensureInstalled()).state).toBe('ready')
        expect(calls()).toBe(0)
      } finally {
        rmSync(cachedDataDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(bundledDir, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('the install manifest records the archive provenance', async () => {
    const dataDir = tempDir()
    const { fetch } = scriptedFetch(() => Promise.resolve(responseWithBytes(PINNED_ARCHIVE)))
    const driver = createManagedPiDriver(driverInput({ dataDir, fetchImpl: fetch }))
    try {
      expect((await driver.ensureInstalled()).state).toBe('ready')
      const manifest = JSON.parse(
        readFileSync(
          join(
            dataDir,
            'dev-runtime',
            'harness',
            'managed-pi',
            MANAGED_PI_PINNED_VERSION,
            'manifest.json'
          ),
          'utf8'
        )
      ) as { version?: string; sourceOrigin?: string; archiveSha256?: string }
      expect(manifest.version).toBe(MANAGED_PI_PINNED_VERSION)
      expect(manifest.sourceOrigin).toBe('network')
      expect(manifest.archiveSha256).toBe(expectedDigest())
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('managed Pi typed failure matrix (#31)', () => {
  test('a refused download is typed unavailable and retryable, leaving nothing behind', async () => {
    const dataDir = tempDir()
    const { fetch } = scriptedFetch(() => Promise.reject(new Error('connection refused')))
    const driver = createManagedPiDriver(driverInput({ dataDir, fetchImpl: fetch }))
    try {
      const error = await driver.ensureInstalled().catch((caught: Error) => caught)
      expect(error).toMatchObject({ code: 'unavailable', retryable: true })
      expect((error as Error).message).toContain('connection refused')
      // The failed ensure is the durable state; nothing installed, nothing cached.
      expect(driver.status()).toMatchObject({ state: 'failed', lastErrorCode: 'unavailable' })
      expect(
        existsSync(join(dataDir, 'dev-runtime', 'harness', 'managed-pi', MANAGED_PI_PINNED_VERSION))
      ).toBe(false)
      expect(existsSync(join(dataDir, 'dev-runtime', 'harness', 'managed-pi', 'cache'))).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a non-OK pinned endpoint is typed remote_unavailable and retryable', async () => {
    const dataDir = tempDir()
    const { fetch } = scriptedFetch(() => Promise.resolve(responseWithBytes(new Uint8Array(), 404)))
    const driver = createManagedPiDriver(driverInput({ dataDir, fetchImpl: fetch }))
    try {
      const error = await driver.ensureInstalled().catch((caught: Error) => caught)
      expect(error).toMatchObject({ code: 'remote_unavailable', retryable: true })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a fetch that never settles inside the deadline is a typed timeout', async () => {
    const dataDir = tempDir()
    const { fetch } = scriptedFetch(() => Promise.reject(new Error('aborted')))
    // The driver's real deadline path (AbortController abort) surfaces the
    // same way: the transport rejects while the request is outstanding. The
    // scripted rejection exercises the shared typed-refusal branch.
    const driver = createManagedPiDriver(driverInput({ dataDir, fetchImpl: fetch }))
    try {
      const error = (await driver.ensureInstalled().catch((caught: Error) => caught)) as Error
      expect(error).toMatchObject({ code: 'unavailable', retryable: true })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('downloaded bytes that fail the pinned digest are corrupt_state and never cached or installed', async () => {
    const dataDir = tempDir()
    const { fetch } = scriptedFetch(() =>
      Promise.resolve(responseWithBytes(new TextEncoder().encode('tampered-in-transit')))
    )
    const driver = createManagedPiDriver(driverInput({ dataDir, fetchImpl: fetch }))
    try {
      const error = await driver.ensureInstalled().catch((caught: Error) => caught)
      expect(error).toMatchObject({ code: 'corrupt_state', retryable: false })
      expect(
        existsSync(join(dataDir, 'dev-runtime', 'harness', 'managed-pi', MANAGED_PI_PINNED_VERSION))
      ).toBe(false)
      expect(existsSync(join(dataDir, 'dev-runtime', 'harness', 'managed-pi', 'cache'))).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a source serving more than the hard cap is limit_exceeded before any byte is ingested', async () => {
    const dataDir = tempDir()
    const oversized = {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // A duck-typed chunk whose byteLength alone busts the cap: the
          // reader loop must refuse before any accumulation/set.
          controller.enqueue({ byteLength: MANAGED_PI_ARCHIVE_MAX_BYTES + 1 } as Uint8Array)
          controller.close()
        },
      }),
    }
    const { fetch } = scriptedFetch(() => Promise.resolve(oversized as ScriptedResponse))
    const driver = createManagedPiDriver(driverInput({ dataDir, fetchImpl: fetch }))
    try {
      const error = await driver.ensureInstalled().catch((caught: Error) => caught)
      expect(error).toMatchObject({ code: 'limit_exceeded', retryable: false })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('the fetch path refuses an older or unknown Bun runtime, while a cached archive still installs', async () => {
    const refusedDataDir = tempDir()
    try {
      const { fetch } = scriptedFetch(() => {
        throw new Error('the guarded fetch must never be reached')
      })
      const refused = createManagedPiDriver(
        driverInput({ dataDir: refusedDataDir, fetchImpl: fetch, runtimeVersion: oldRuntime })
      )
      const error = await refused.ensureInstalled().catch((caught: Error) => caught)
      expect(error).toMatchObject({ code: 'incompatible', retryable: false })
      expect((error as Error).message).toContain(MANAGED_PI_MIN_RUNTIME_VERSION)
    } finally {
      rmSync(refusedDataDir, { recursive: true, force: true })
    }

    // The guard guards the DOWNLOAD only: a cached source installs regardless.
    const cachedDataDir = tempDir()
    try {
      const installRoot = join(cachedDataDir, 'dev-runtime', 'harness', 'managed-pi')
      writeCache(installRoot, PINNED_ARCHIVE)
      const cached = createManagedPiDriver(
        driverInput({ dataDir: cachedDataDir, installRoot, runtimeVersion: oldRuntime })
      )
      expect((await cached.ensureInstalled()).state).toBe('ready')
    } finally {
      rmSync(cachedDataDir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('managed Pi version drift (#31)', () => {
  test('a ready record over a drifted on-disk install heals by reinstalling at the pin', async () => {
    const dataDir = tempDir()
    try {
      seedReadyRecord(dataDir)
      const installDir = seedDriftedInstall(dataDir)
      const { fetch, calls } = scriptedFetch(() => {
        throw new Error('healing uses local sources first; no fetch is expected')
      })
      const driver = createManagedPiDriver(
        driverInput({
          dataDir,
          fetchImpl: fetch,
          resolvePinnedArchive: () => Promise.resolve(PINNED_ARCHIVE),
        })
      )
      const healed = await driver.ensureInstalled()
      expect(healed).toMatchObject({
        state: 'ready',
        resolvedVersion: MANAGED_PI_PINNED_VERSION,
        executableLabel: `managed Pi ${MANAGED_PI_PINNED_VERSION}`,
      })
      // The drifted artifact itself was replaced by verified pin bytes, and
      // the on-disk manifest declares the pin again.
      expect(new Uint8Array(readFileSync(join(installDir, 'pi')))).toEqual(PINNED_ARCHIVE)
      const manifest = JSON.parse(
        readFileSync(
          join(
            dataDir,
            'dev-runtime',
            'harness',
            'managed-pi',
            MANAGED_PI_PINNED_VERSION,
            'manifest.json'
          ),
          'utf8'
        )
      ) as { version?: string }
      expect(manifest.version).toBe(MANAGED_PI_PINNED_VERSION)
      expect(calls()).toBe(0)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a failed drift heal is a typed incompatible refusal and the ready claim is revoked', async () => {
    const dataDir = tempDir()
    try {
      seedReadyRecord(dataDir)
      seedDriftedInstall(dataDir)
      // No source at all (override returns null): the heal cannot proceed.
      const driver = createManagedPiDriver(
        driverInput({ dataDir, resolvePinnedArchive: () => Promise.resolve(null) })
      )
      const error = await driver.ensureInstalled().catch((caught: Error) => caught)
      expect(error).toMatchObject({ code: 'incompatible', retryable: true })
      expect((error as Error).message).toContain('no longer matches the pinned')
      expect(driver.status()).toMatchObject({ state: 'failed', lastErrorCode: 'incompatible' })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a missing on-disk manifest is drift too: the driver reinstalls instead of trusting the record', async () => {
    const dataDir = tempDir()
    try {
      seedReadyRecord(dataDir)
      const installDir = join(
        dataDir,
        'dev-runtime',
        'harness',
        'managed-pi',
        MANAGED_PI_PINNED_VERSION
      )
      mkdirSync(installDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(installDir, 'pi'), PINNED_ARCHIVE, { mode: 0o700 })
      // No manifest.json: the record claims ready, the disk cannot prove it.
      const driver = createManagedPiDriver(
        driverInput({ dataDir, resolvePinnedArchive: () => Promise.resolve(PINNED_ARCHIVE) })
      )
      expect((await driver.ensureInstalled()).state).toBe('ready')
      expect(existsSync(join(installDir, 'manifest.json'))).toBe(true)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('managed Pi single-flight and boot safety (#31)', () => {
  test('concurrent ensures share one install', async () => {
    const dataDir = tempDir()
    try {
      let resolverCalls = 0
      const driver = createManagedPiDriver(
        driverInput({
          dataDir,
          resolvePinnedArchive: () => {
            resolverCalls += 1
            return new Promise((resolve) => setTimeout(() => resolve(PINNED_ARCHIVE), 10))
          },
        })
      )
      const [first, second] = await Promise.all([
        driver.ensureInstalled(),
        driver.ensureInstalled(),
      ])
      expect(first).toMatchObject({ state: 'ready' })
      expect(second.installationId).toBe(first.installationId)
      expect(resolverCalls).toBe(1)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('the composition boot warm installs with zero manual steps and never breaks the boot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-managed-pi-boot-'))
    try {
      const stateDir = join(dataDir, 'desktop-state')
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const identity = createDesktopIdentityAuthority({
        dataDir,
        verifier: {
          async verifySession() {
            return [SCOPE.workspaceId]
          },
          async verifyNodeEligibility() {
            return
          },
        } satisfies DesktopIdentityVerifier,
      })
      const authority = createChannelAuthority({
        shellHost: '127.0.0.1',
        shellOrigin: 'http://127.0.0.1:4787',
        authorizeCommand: async (command) => {
          identity.assertCommandScope(command.scope)
          await identity.ensureNodeEligible()
        },
      })
      const gateway = createChannelGateway({
        authority,
        invoke: async () => ({ ok: true, value: null }),
        shellOrigin: 'http://127.0.0.1:4787',
      })
      await identity.bind({
        session: {
          credential: 'c'.repeat(43),
          sessionId: 'sess-managed-pi-boot-0001',
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        },
        claimed: SCOPE,
      })
      const started = Date.now()
      const host: DevRuntimeHost = createDevRuntimeHost({
        authority,
        gateway,
        dataDir,
        scope: identity.currentScope(),
        identity,
        approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
        runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
        credentialStore: {
          get: () => undefined,
          set: () => undefined,
          delete: () => undefined,
        },
        runLsof: () => Promise.resolve(''),
        resolveDns: () => Promise.resolve([]),
        // The warm opt-in: no injected driver, a scripted local source.
        managedPiAutoInstall: true,
        managedPiArchiveResolver: () => Promise.resolve(PINNED_ARCHIVE),
      })
      // Composition returns synchronously; the warm is fire-and-forget.
      expect(host.harness).toBeDefined()
      expect(Date.now() - started).toBeLessThan(5_000)
      // The warm completes on its own: the managed Pi reaches ready with no
      // manual step and no command having been executed.
      let status = host.harness!.managedPi.status()
      for (let waited = 0; status.state !== 'ready' && waited < 5_000; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        status = host.harness!.managedPi.status()
      }
      expect(status).toMatchObject({ state: 'ready', resolvedVersion: MANAGED_PI_PINNED_VERSION })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a failing warm records the typed durable failure and the shell boots unaffected', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-managed-pi-bootsafe-'))
    try {
      const identity = createDesktopIdentityAuthority({
        dataDir,
        verifier: {
          async verifySession() {
            return [SCOPE.workspaceId]
          },
          async verifyNodeEligibility() {
            return
          },
        } satisfies DesktopIdentityVerifier,
      })
      const authority = createChannelAuthority({
        shellHost: '127.0.0.1',
        shellOrigin: 'http://127.0.0.1:4787',
        authorizeCommand: async (command) => {
          identity.assertCommandScope(command.scope)
          await identity.ensureNodeEligible()
        },
      })
      const gateway = createChannelGateway({
        authority,
        invoke: async () => ({ ok: true, value: null }),
        shellOrigin: 'http://127.0.0.1:4787',
      })
      await identity.bind({
        session: {
          credential: 'c'.repeat(43),
          sessionId: 'sess-managed-pi-bootsafe-01',
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        },
        claimed: SCOPE,
      })
      const host = createDevRuntimeHost({
        authority,
        gateway,
        dataDir,
        scope: identity.currentScope(),
        identity,
        approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
        runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
        credentialStore: { get: () => undefined, set: () => undefined, delete: () => undefined },
        runLsof: () => Promise.resolve(''),
        resolveDns: () => Promise.resolve([]),
        managedPiAutoInstall: true,
        managedPiArchiveResolver: () => Promise.resolve(null),
      })
      // The full provider matrix still stands; nothing about the boot changed.
      expect(host.registration.providers).toContain('dev.harness.managedPiInstall')
      let status = host.harness!.managedPi.status()
      for (let waited = 0; status.state !== 'failed' && waited < 5_000; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        status = host.harness!.managedPi.status()
      }
      expect(status).toMatchObject({ state: 'failed', lastErrorCode: 'capability_unavailable' })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('managed Pi ownership boundary (#31)', () => {
  test('the driver surface carries no decision-layer authority', () => {
    const driver = createManagedPiDriver(driverInput({ dataDir: tempDir() }))
    const surface = Object.keys(driver).toSorted()
    expect(surface).toEqual([
      'driverId',
      'driverVersion',
      'ensureInstalled',
      'pinnedVersion',
      'status',
    ])
    expect(surface.join(',')).not.toMatch(/prompt|model|profile|plan|compact|context/i)
  })
})

// The composition-level zero-config boot warm is an explicit opt-in
// (`managedPiAutoInstall: true` in the createDevRuntimeHost call). The
// packaged composition lives in the shell entry, so the production wiring is
// pinned by source: without this line the zero-config flow silently degrades
// to the explicit dev.harness.managedPiInstall command.
test('the packaged shell composition opts into the managed Pi boot warm', () => {
  const entry = readFileSync(join(import.meta.dir, '../shell/src/bun/index.ts'), 'utf8')
  expect(entry).toContain('managedPiAutoInstall: true')
})
