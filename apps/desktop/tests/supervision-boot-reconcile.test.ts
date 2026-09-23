// Boot-time supervision adoption (M10 #185) and the shell terminal lane's
// sidecar adoption seam (issue #396). The production wiring lives in
// `apps/desktop/shell/src/bun/boot-supervision.ts` (the entry itself opens
// the Electrobun window and cannot be imported here): after the composition
// holds the one supervision engine, the persisted launch journal is
// reconciled — a sidecar launch persisted by a previous app run is ADOPTED
// through the full ownership re-proof, or journaled as an UNADOPTABLE
// expected exit; a composition without an engine reconciles nothing. The
// terminal lane adopts its sidecar through the existing seam: packaged
// boots start it through the engine, dev runs keep the dev fallback.
import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeComponentManifest,
  type ComponentManifest,
} from '../shell/src/supervision/component-manifest'
import type { SupervisionAdapter } from '../shell/src/supervision/supervisor'
import { createSupervisor } from '../shell/src/supervision/supervisor'
import { createRecordStore } from '../shell/src/supervision/records'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import { createInMemoryVaultKeyStore } from '../shell/src/dev-runtime/vault'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import {
  adoptShellTerminalSidecar,
  reconcileSupervisionAtBoot,
} from '../shell/src/bun/boot-supervision'
import { devSidecarPlan } from '../shell/src/bun/boot-sidecar-plan'

const SCOPE = {
  accountId: '00000000-0000-4000-8000-0000000000a1',
  workspaceId: '00000000-0000-4000-8000-0000000000b2',
  runtimeNodeId: '00000000-0000-4000-8000-0000000000c3',
}

const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-boot-reconcile-0001',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}

function fakeVerifier(): DesktopIdentityVerifier {
  return {
    async verifySession() {
      return [SCOPE.workspaceId]
    },
    async verifyNodeEligibility() {},
  }
}

function sidecarManifest(): ComponentManifest {
  const decoded = decodeComponentManifest({
    schemaVersion: 1,
    components: [
      {
        id: 'dev-runtime-sidecar',
        product: 'Dev Runtime terminal sidecar',
        version: '1.0.0',
        platform: 'universal',
        arch: 'universal',
        digestSha256: 'a'.repeat(64),
        signature: 'c2ln',
        compatibility: { minAppVersion: '0.1.0', maxAppVersion: '99.0.0' },
        installLocation: 'Contents/Resources/app/dev-runtime-sidecar/entry.js',
        dataLocation: 'dev-runtime/terminal-sidecar',
        startupPhase: 0,
        dependsOn: [],
        healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
        // The wire protocol constant: the engine's adoption verdict compares
        // name and major against what the sidecar registers with.
        protocol: { name: 'adea-terminal-sidecar', major: 1, minor: 0 },
        rollbackTargetVersion: null,
        required: false,
      },
    ],
  })
  if (!decoded.ok) throw new Error(`fixture manifest rejected: ${decoded.reason}`)
  return decoded.manifest
}

/** Fake adapter: processes live until the test exits or rekeys them (the
 *  supervision suite's deterministic fixture shape). */
function fakeAdapter() {
  let nextPid = 100
  const live = new Map<number, { pidStartIdentity: string; executableIdentity: string }>()
  const adapter = {
    async spawn(spec: { id: string }) {
      const pid = ++nextPid
      live.set(pid, {
        pidStartIdentity: `start-${pid}`,
        executableIdentity: `bundle://${spec.id}@1.0.0`,
      })
      return {
        identity: {
          pid,
          pidStartIdentity: `start-${pid}`,
          executableIdentity: `bundle://${spec.id}@1.0.0`,
        },
        processGroup: `pgid-${pid}`,
      }
    },
    async currentIdentity(pid: number) {
      const identity = live.get(pid)
      return identity ? { ...identity, processGroup: `pgid-${pid}` } : null
    },
    async probe() {
      return 'responsive' as const
    },
    async signalIdentity(identity: { pid: number }) {
      live.delete(identity.pid)
    },
  }
  return { adapter: adapter as SupervisionAdapter, alive: (pid: number) => live.has(pid) }
}

/** Boots the composition the way the shell entry does: one channel
 *  authority, the composition root, the component manifest and the scripted
 *  supervision adapter when provided. */
async function boot(options: {
  manifest?: ComponentManifest
  adapter?: SupervisionAdapter
  recordsDir?: string
}): Promise<{ host: DevRuntimeHost; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-boot-reconcile-'))
  const identity = createDesktopIdentityAuthority({ dataDir, verifier: fakeVerifier() })
  await identity.bind({ session: SESSION, claimed: SCOPE })
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1:4789',
    shellOrigin: 'http://127.0.0.1:4789',
  })
  const host = createDevRuntimeHost({
    authority,
    dataDir,
    scope: identity.currentScope(),
    identity,
    approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
    // The system keychain is darwin-only; these boot tests assert reconcile
    // semantics, not vault plumbing, so the composition gets the in-memory
    // store the same way the harness boots do.
    credentialStore: createInMemoryVaultKeyStore(),
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    ...(options.manifest ? { componentManifest: options.manifest } : {}),
    ...(options.adapter ? { supervisionAdapter: options.adapter } : {}),
    ...(options.recordsDir ? { supervisionRecordsDir: options.recordsDir } : {}),
  })
  return { host, dataDir }
}

function seedLaunch(
  recordsDir: string,
  overrides: Partial<{
    pid: number
    pidStartIdentity: string
    executableIdentity: string
    processRecordId: string
    generation: number
  }> = {}
): { processRecordId: string; pid: number } {
  const pid = overrides.pid ?? 101
  createRecordStore(recordsDir).append({
    kind: 'launched',
    at: new Date().toISOString(),
    componentId: 'dev-runtime-sidecar',
    generation: overrides.generation ?? 1,
    processRecordId: overrides.processRecordId ?? 'persisted-launch',
    identity: {
      pid,
      pidStartIdentity: overrides.pidStartIdentity ?? `start-${pid}`,
      executableIdentity: overrides.executableIdentity ?? 'bundle://dev-runtime-sidecar@1.0.0',
    },
    processGroup: `pgid-${pid}`,
  })
  return { processRecordId: overrides.processRecordId ?? 'persisted-launch', pid }
}

describe('boot reconcile (#185): persisted launch adoption', () => {
  test('a sidecar launch persisted by a previous app run is adopted', async () => {
    const recordsDir = mkdtempSync(join(tmpdir(), 'adea-boot-reconcile-records-'))
    // The persisted launch names a pid that is still alive with the same
    // identity (a live sidecar from the previous app run).
    const seeded = seedLaunch(recordsDir, { pid: 101 })
    const booted = await boot({
      manifest: sidecarManifest(),
      adapter: livePidAdapter(101),
      recordsDir,
    })
    try {
      const supervision = booted.host.supervision
      expect(supervision).toBeDefined()
      if (!supervision || !booted.host.supervisionRecords) return
      const outcome = await reconcileSupervisionAtBoot(booted.host)
      expect(outcome.attempted).toBe(true)
      if (!outcome.attempted) return
      expect(outcome.adopted).toEqual([
        {
          componentId: 'dev-runtime-sidecar',
          processRecordId: seeded.processRecordId,
          generation: 1,
          pid: 101,
        },
      ])
      expect(outcome.unadoptable).toEqual([])
      const snapshot = supervision.snapshot().components[0]
      expect(snapshot.state).toBe('running')
      expect(snapshot.launch?.identity.pid).toBe(101)
      expect(snapshot.generation).toBe(1)
      // Adoption appends nothing: the journal is unchanged.
      expect(
        booted.host.supervisionRecords.list().filter((record) => record.kind === 'exited')
      ).toEqual([])
    } finally {
      rmSync(booted.dataDir, { recursive: true, force: true })
      rmSync(recordsDir, { recursive: true, force: true })
    }
  })

  test('a persisted launch that fails the ownership re-proof is journaled unadoptable', async () => {
    const recordsDir = mkdtempSync(join(tmpdir(), 'adea-boot-reconcile-records-'))
    // The persisted pid holds nothing anymore (the previous app's sidecar died).
    const seeded = seedLaunch(recordsDir, { pid: 404 })
    const booted = await boot({
      manifest: sidecarManifest(),
      adapter: fakeAdapter().adapter,
      recordsDir,
    })
    try {
      const outcome = await reconcileSupervisionAtBoot(booted.host)
      expect(outcome.attempted).toBe(true)
      if (!outcome.attempted) return
      expect(outcome.adopted).toEqual([])
      expect(outcome.unadoptable).toEqual([
        {
          componentId: 'dev-runtime-sidecar',
          processRecordId: seeded.processRecordId,
          generation: 1,
          pid: 404,
        },
      ])
      // The engine journaled the expected exit, so the record cannot dangle.
      const supervisionRecords = booted.host.supervisionRecords
      const supervision = booted.host.supervision
      if (!supervision || !supervisionRecords) return
      const exited = supervisionRecords.list().filter((record) => record.kind === 'exited')
      expect(exited).toHaveLength(1)
      expect(exited[0]).toMatchObject({
        componentId: 'dev-runtime-sidecar',
        processRecordId: seeded.processRecordId,
        expected: true,
        exitDetail: 'not observable after supervisor restart',
      })
      expect(supervision.snapshot().components[0].state).toBe('idle')
    } finally {
      rmSync(booted.dataDir, { recursive: true, force: true })
      rmSync(recordsDir, { recursive: true, force: true })
    }
  })

  test('a launch this supervisor already owns is skipped, never clobbered', async () => {
    const recordsDir = mkdtempSync(join(tmpdir(), 'adea-boot-reconcile-records-'))
    const booted = await boot({
      manifest: sidecarManifest(),
      adapter: fakeAdapter().adapter,
      recordsDir,
    })
    try {
      const supervision = booted.host.supervision
      if (!supervision) return
      // The engine owns its own launch, then a stale persisted record for the
      // same live pid appears (an app-level start/reconcile race).
      const started = await supervision.start({
        componentId: 'dev-runtime-sidecar',
        idempotencyKey: 'already-owned',
      })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      seedLaunch(recordsDir, {
        pid: started.value.identity.pid,
        pidStartIdentity: started.value.identity.pidStartIdentity,
        executableIdentity: started.value.identity.executableIdentity,
        processRecordId: 'stale-record',
        generation: 99,
      })
      const outcome = await reconcileSupervisionAtBoot(booted.host)
      expect(outcome.attempted).toBe(true)
      if (!outcome.attempted) return
      expect(outcome.adopted).toEqual([])
      expect(outcome.unadoptable).toEqual([])
      expect(outcome.skipped).toEqual(['dev-runtime-sidecar'])
      // The engine's own launch survived: the stale record clobbered nothing.
      expect(supervision.snapshot().components[0].launch?.identity.pid).toBe(
        started.value.identity.pid
      )
    } finally {
      rmSync(booted.dataDir, { recursive: true, force: true })
      rmSync(recordsDir, { recursive: true, force: true })
    }
  })

  test('a boot without a component manifest reconciles nothing', async () => {
    const booted = await boot({})
    try {
      expect(booted.host.supervision).toBeUndefined()
      expect(booted.host.supervisionRecords).toBeUndefined()
      const outcome = await reconcileSupervisionAtBoot(booted.host)
      expect(outcome).toEqual({ attempted: false })
    } finally {
      rmSync(booted.dataDir, { recursive: true, force: true })
    }
  })

  test('a reconcile that throws is reported, never propagated to the boot', async () => {
    const supervisor = createSupervisor({
      manifest: sidecarManifest(),
      adapter: fakeAdapter().adapter,
    })
    const outcome = await reconcileSupervisionAtBoot({
      supervision: supervisor,
      supervisionRecords: {
        list(): readonly never[] {
          throw new Error('journal unreadable')
        },
      },
    })
    expect(outcome.attempted).toBe(true)
    if (!outcome.attempted) return
    expect(outcome.error).toBe('journal unreadable')
    expect(outcome.adopted).toEqual([])
    expect(outcome.unadoptable).toEqual([])
  })

  // #185 acceptance: "Agent HQ Channel/Message and encrypted ContentRef history
  // survive Control Plane/Restate/runtime update/restart independently from
  // native session history", and #34's "canonical history remains intact across
  // component restart even when native runtime session history is unavailable".
  // Both were structural (separate stores) and unpinned.
  test('a component restart leaves Agent HQ history and the vault untouched, even with the component history gone', async () => {
    const recordsDir = mkdtempSync(join(tmpdir(), 'adea-state-independence-'))
    const seeded = seedLaunch(recordsDir, { pid: 707 })
    const booted = await boot({
      manifest: sidecarManifest(),
      adapter: livePidAdapter(707),
      recordsDir,
    })
    try {
      // Agent HQ's own durable state, staged where the app keeps it: the
      // encrypted local-content store and the M10 credential vault.
      const contentDir = join(booted.dataDir, 'local-content')
      const contentStore = join(contentDir, 'agent-hq-content.sqlite')
      const vaultDir = join(booted.dataDir, 'dev-runtime', 'vault')
      mkdirSync(contentDir, { recursive: true, mode: 0o700 })
      mkdirSync(vaultDir, { recursive: true, mode: 0o700 })
      writeFileSync(contentStore, 'encrypted-channel-message-history')
      writeFileSync(join(vaultDir, 'credentials.sqlite3'), 'vault-bytes')
      const contentBefore = readFileSync(contentStore, 'utf8')
      const vaultBefore = readFileSync(join(vaultDir, 'credentials.sqlite3'), 'utf8')

      // The component's OWN data — the native runtime session history — is gone
      // between runs: the shape where the component cannot replay from its own
      // state and Agent HQ must not be affected by that absence.
      const componentData = join(booted.dataDir, 'dev-runtime', 'terminal-sidecar')
      mkdirSync(componentData, { recursive: true, mode: 0o700 })
      writeFileSync(join(componentData, 'session.log'), 'native-history')
      rmSync(componentData, { recursive: true, force: true })

      const outcome = await reconcileSupervisionAtBoot(booted.host)
      expect(outcome.attempted).toBe(true)
      if (!outcome.attempted) return
      // The restart really reconciled the component (the launch was adopted),
      // so the assertions below are about a restart that happened, not a no-op.
      expect(outcome.adopted).toEqual([
        {
          componentId: 'dev-runtime-sidecar',
          processRecordId: seeded.processRecordId,
          generation: 1,
          pid: 707,
        },
      ])

      // Agent HQ's history is byte-identical afterwards.
      expect(readFileSync(contentStore, 'utf8')).toBe(contentBefore)
      expect(readFileSync(join(vaultDir, 'credentials.sqlite3'), 'utf8')).toBe(vaultBefore)
      expect(readdirSync(contentDir)).toEqual(['agent-hq-content.sqlite'])
      // Nothing was fabricated to fill the gap the component left behind.
      expect(existsSync(componentData)).toBe(false)
    } finally {
      rmSync(booted.dataDir, { recursive: true, force: true })
      rmSync(recordsDir, { recursive: true, force: true })
    }
  })
})

/** Wraps the fake adapter so a specific seeded pid answers as alive for the
 *  adoption test (the fixture's own spawns start above it, leaving the
 *  seeded pid foreign). */
function livePidAdapter(pid: number): SupervisionAdapter {
  const inner = fakeAdapter().adapter
  return {
    ...inner,
    async currentIdentity(queried: number) {
      if (queried === pid) {
        return {
          pid,
          pidStartIdentity: `start-${pid}`,
          executableIdentity: 'bundle://dev-runtime-sidecar@1.0.0',
          processGroup: `pgid-${pid}`,
        }
      }
      return inner.currentIdentity(queried)
    },
  }
}

describe('boot reconcile (#185): the production entry wiring', () => {
  test('the shell entry reconciles at boot and adopts the sidecar through the seam', async () => {
    const source = await Bun.file(
      new URL('../shell/src/bun/index.ts', import.meta.url).pathname
    ).text()
    expect(source).toContain('reconcileSupervisionAtBoot(host)')
    expect(source).toContain('adoptShellTerminalSidecar(')
    expect(source).toContain('supervisionAdapter')
    expect(source).toContain('componentManifest: packagedManifest.manifest')
    expect(source).toContain('sidecar: sidecarClient')
  })
})

describe('shell terminal lane sidecar adoption (#396): dev fallback', () => {
  test(
    'a dev run adopts the source-tree sidecar through the same seam',
    { timeout: 30_000 },
    async () => {
      if (process.platform !== 'darwin') return
      const dataDir = mkdtempSync(join(tmpdir(), 'adea-boot-sidecar-dev-'))
      try {
        const adoption = await adoptShellTerminalSidecar({
          dataDir,
          scope: SCOPE,
          plan: devSidecarPlan(),
        })
        expect(adoption.ok).toBe(true)
        if (!adoption.ok) return
        expect(adoption.startedBySupervision).toBe(false)
        expect(adoption.client.welcome.sidecarVersion).toBe('dev')
        expect(adoption.client.welcome.protocol).toMatchObject({
          name: 'adea-terminal-sidecar',
          major: 1,
        })
        adoption.client.close()
        // Cleanup: the endpoint's pid is the only handle the plan returns.
        try {
          process.kill(adoption.client.welcome.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  )
})
