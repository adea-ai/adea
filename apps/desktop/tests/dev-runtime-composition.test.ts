// Control-plane composition acceptance: boots the actual shell registration
// graph (channel authority → identity authority → gateway → Dev Runtime host
// composition, exactly as apps/desktop/shell/src/bun/index.ts wires it) and
// pins the operation/provider matrix. Every registry operation must be a
// reachable provider or a documented typed-unavailable host capability
// result; scope admission must precede capability checks; revoked nodes,
// rebinds, workspace switches, and unbinds must fail closed.
import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDecoders,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type Project,
  type RetainedDataRecord,
  type Scope,
  type Worktree,
} from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import {
  ChannelRejection,
  createChannelAuthority,
} from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import {
  decodeComponentManifest,
  type ComponentManifest,
} from '../shell/src/supervision/component-manifest'
import type { SupervisionAdapter } from '../shell/src/supervision/supervisor'
import {
  findRunningAppBundle,
  loadPackagedManifestForEntry,
} from '../shell/scripts/packaged-install'

const SHELL_HOST = '127.0.0.1'
const SHELL_PORT = 4789
const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`

const SCOPE_A: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const SCOPE_B: Scope = {
  accountId: SCOPE_A.accountId,
  workspaceId: '00000000-0000-4000-8000-000000000077',
  runtimeNodeId: SCOPE_A.runtimeNodeId,
}
const OTHER_SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000099',
  workspaceId: '00000000-0000-4000-8000-000000000098',
  runtimeNodeId: '00000000-0000-4000-8000-000000000097',
}

const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-0000-0000-0000-0001',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}

function fakeCloudVerifier(options: {
  workspaces?: readonly string[]
  revoked?: boolean
  unreachable?: boolean
}): DesktopIdentityVerifier {
  return {
    async verifySession() {
      if (options.unreachable) {
        throw new ChannelRejection('runtime_node_unavailable', 'identity unreachable', 503, true)
      }
      return options.workspaces ?? [SCOPE_A.workspaceId]
    },
    async verifyNodeEligibility() {
      if (options.revoked) {
        throw new ChannelRejection(
          'runtime_node_revoked',
          'the runtime node is not eligible for privileged operations',
          403
        )
      }
      if (options.unreachable) {
        throw new ChannelRejection('runtime_node_unavailable', 'identity unreachable', 503, true)
      }
    },
  }
}

type Boot = {
  authority: ReturnType<typeof createChannelAuthority>
  identity: ReturnType<typeof createDesktopIdentityAuthority>
  gateway: ReturnType<typeof createChannelGateway>
  /** The live composition; re-created on identity rebind, as in production. */
  currentHost(): DevRuntimeHost
  dataDir: string
  bind(scope?: Scope): Promise<Scope>
  openChannel(): Promise<{
    channelId: string
    clientCredentialId: string
    secret: Buffer
    execute(command: DevCommand): Promise<DevReply>
  }>
}

/**
 * Boots the production graph exactly as bun/index.ts wires it: one channel
 * authority whose authorizeCommand performs identity scope admission plus
 * bounded-TTL node eligibility, one gateway, and the composition root.
 */
async function boot(
  options: {
    verifier?: DesktopIdentityVerifier
    sidecar?: unknown
    publish?: (event: string, payload: unknown) => void
    /** Fresh-install boot: no binding exists before composition. */
    unbound?: boolean
    /** #424: compose a component manifest in (binds the supervision engine). */
    componentManifest?: ComponentManifest
    /** #424: scripted supervision process adapter for the bound engine. */
    supervisionAdapter?: SupervisionAdapter
    /** #424: scripted process sampler (replaces the real `ps` sampler). */
    sampleProcesses?: (
      pids: readonly number[]
    ) => Promise<readonly { pid: number; cpuSeconds?: number; residentBytes?: number }[]>
    /** #424: scripted retained-data source. */
    retainedData?: () => readonly RetainedDataRecord[]
  } = {}
): Promise<Boot> {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-composition-'))
  // The client's sealed session vault (same device-key AES-GCM scheme as the
  // command surface) is what lets the shell re-prove node eligibility.
  const stateDir = join(dataDir, 'desktop-state')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const deviceKey = randomBytes(32)
  writeFileSync(join(stateDir, 'device.key'), deviceKey, { mode: 0o600 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deviceKey, iv)
  // commands.ts seal format: base64(iv || authTag || ciphertext)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(SESSION), 'utf8'), cipher.final()])
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  writeFileSync(join(stateDir, 'session.sealed'), sealed.toString('base64'), { mode: 0o600 })
  const identity = createDesktopIdentityAuthority({
    dataDir,
    verifier: options.verifier ?? fakeCloudVerifier({}),
  })
  const authority = createChannelAuthority({
    shellHost: SHELL_HOST,
    shellOrigin: SHELL_ORIGIN,
    authorizeCommand: async (command) => {
      identity.assertCommandScope(command.scope)
      await identity.ensureNodeEligible()
    },
  })
  const gateway = createChannelGateway({
    authority,
    invoke: async () => ({ ok: true, value: null }),
    shellOrigin: SHELL_ORIGIN,
  })
  if (!options.unbound) {
    await identity.bind({ session: SESSION, claimed: SCOPE_A })
  }
  const compositionInput = {
    authority,
    gateway,
    dataDir,
    scope: identity.currentScope(),
    identity,
    approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
    // Deterministic key store: the OS `security` CLI does not exist on the
    // Linux unit lane, and the vault must construct identically everywhere.
    credentialStore: (() => {
      const keys = new Map<string, Buffer>()
      return {
        get: (service: string, account: string) => keys.get(`${service}\u0000${account}`),
        set: (service: string, account: string, key: Buffer) =>
          void keys.set(`${service}\u0000${account}`, key),
        delete: (service: string, account: string) =>
          void keys.delete(`${service}\u0000${account}`),
      }
    })(),
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    ...(options.publish ? { publish: options.publish } : {}),
    ...(options.sidecar ? { sidecar: options.sidecar as never } : {}),
    ...(options.componentManifest ? { componentManifest: options.componentManifest } : {}),
    ...(options.supervisionAdapter ? { supervisionAdapter: options.supervisionAdapter } : {}),
    ...(options.sampleProcesses ? { sampleProcesses: options.sampleProcesses } : {}),
    ...(options.retainedData ? { retainedData: options.retainedData } : {}),
  }
  let host = createDevRuntimeHost(compositionInput)
  // Mirror bun/index.ts: a re-bind under a new scope recomposes the host
  // after the composition revoked the previous binding's channels.
  identity.onBindingChanged(() => {
    host = createDevRuntimeHost({ ...compositionInput, scope: identity.currentScope() })
  })
  mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })
  return {
    authority,
    identity,
    gateway,
    currentHost: () => host,
    dataDir,
    async bind(scope: Scope = SCOPE_A) {
      return identity.bind({ session: SESSION, claimed: scope })
    },
    async openChannel() {
      const reply = authority.handshake(
        {
          schemaVersion: 1,
          method: 'dev.runtime.handshake.v1',
          requestId: randomUUID(),
          bootstrap: authority.issueLaunchBootstrap(),
          supportedProtocolVersions: ['1'],
          nonce: randomBytes(24).toString('base64url'),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
        { trusted: true }
      )
      if (!reply.ok) throw new Error('handshake failed')
      const secret = Buffer.from(reply.clientSecret, 'base64url')
      const channelId = reply.channelId
      const clientCredentialId = reply.clientCredentialId
      return {
        channelId,
        clientCredentialId,
        secret,
        async execute(command: DevCommand) {
          return authority.execute(
            {
              channelId,
              clientCredentialId,
              command,
              proof: createHmac('sha256', secret)
                .update(devCommandProofMessage({ channelId, clientCredentialId, command }))
                .digest('base64url'),
            },
            { trusted: true }
          )
        },
      }
    },
  }
}

function commandFor(
  operation: DevOperation,
  scope: Scope,
  body: Record<string, unknown> = {},
  overrides: Partial<DevCommand> = {}
): DevCommand {
  return {
    schemaVersion: 1,
    operation,
    requestId: randomUUID(),
    nonce: randomBytes(24).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    scope,
    capabilities: [...devOperationDefinitions[operation].capabilities].toSorted(),
    body,
    ...overrides,
  } as DevCommand
}

/** A minimal packaged .app layout on disk with real (tiny) artifacts, so the
 *  packaging lane's install-location resolution and strict decode run against
 *  actual bundled bytes exactly as the production shell entry does at boot
 *  (`bun/index.ts` → `loadPackagedManifestForEntry(import.meta.dir)`). */
function makeFixtureAppBundle(
  options: { omit?: 'bun' | 'launcher'; sidecarIsDirectory?: boolean } = {}
): string {
  const bundle = join(mkdtempSync(join(tmpdir(), 'adea-fixture-app-')), 'Adea-fixture.app')
  const appDir = join(bundle, 'Contents/Resources/app')
  mkdirSync(join(appDir, 'dev-runtime-sidecar'), { recursive: true })
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true })
  if (options.sidecarIsDirectory) {
    mkdirSync(join(appDir, 'dev-runtime-sidecar/entry.js'), { recursive: true })
  } else {
    writeFileSync(join(appDir, 'dev-runtime-sidecar/entry.js'), 'export const sidecar = true\n')
  }
  if (options.omit !== 'bun') writeFileSync(join(bundle, 'Contents/MacOS/bun'), '#!/bin/sh\n')
  if (options.omit !== 'launcher') {
    writeFileSync(join(bundle, 'Contents/MacOS/launcher'), 'launcher-bytes')
  }
  writeFileSync(
    join(bundle, 'Contents/Resources/version.json'),
    JSON.stringify({ version: '9.9.9', channel: 'dev' })
  )
  return bundle
}

/** Scripted supervision adapter: one component launch with a stable identity
 *  the composition's engine can start and observe without OS state. */
function scriptedSupervisionAdapter(): SupervisionAdapter {
  let alive = false
  return {
    async spawn() {
      alive = true
      return {
        identity: {
          pid: 4711,
          pidStartIdentity: 'start-4711',
          executableIdentity: '/exe/sidecar',
        },
        processGroup: 'pg-4711',
      }
    },
    async currentIdentity(pid) {
      if (!alive) return null
      return {
        pid,
        pidStartIdentity: 'start-4711',
        executableIdentity: '/exe/sidecar',
        processGroup: 'pg-4711',
      }
    },
    async probe() {
      return alive ? 'responsive' : 'unresponsive'
    },
    async signalIdentity() {
      alive = false
    },
  }
}

describe('dev runtime composition', () => {
  test('enumerates a total operation/provider matrix over the real graph', async () => {
    const shell = await boot()
    try {
      const all = Object.keys(devOperationDefinitions) as DevOperation[]
      const { providers, typedUnavailable } = shell.currentHost().registration
      // The matrix is a partition of the registry: every operation is either
      // a reachable provider or an explicitly typed-unavailable result.
      expect(providers.length + typedUnavailable.length).toBe(all.length)
      expect(new Set([...providers, ...typedUnavailable]).size).toBe(all.length)

      // Providers with existing production implementations are registered.
      const expectedProviders = [
        'dev.capability.snapshot',
        'dev.project.list',
        'dev.project.get',
        'dev.project.update',
        'dev.project.archive',
        'dev.project.unbind',
        'dev.project.bookmarks',
        // Remote-only projects: the managed bare clone (ADR 0011, PR 15).
        'dev.project.clone',
        'dev.repo.list',
        'dev.repo.credentialRefs',
        // #398 repository registry: adopt/authorize/inspect/refresh.
        'dev.repo.adopt',
        'dev.repo.authorize',
        'dev.repo.inspect',
        'dev.repo.refresh',
        'dev.session.list',
        'dev.session.get',
        'dev.session.create',
        'dev.session.transferInput',
        'dev.session.archive',
        'dev.session.unarchive',
        // #31/#32 harness substrate: managed Pi, ACP lane, and run status.
        'dev.harness.managedPiStatus',
        'dev.harness.managedPiInstall',
        'dev.harness.acpConnect',
        'dev.harness.acpConnections',
        'dev.harness.acpClose',
        'dev.harness.runs',
        // #400 launch orchestration: preferences/root default, observed run
        // status, the default-harness launch, and the runtime-events-v1 grant.
        'dev.harness.preferences',
        'dev.harness.preferenceUpdate',
        'dev.harness.preferenceReset',
        'dev.harness.runStatus',
        'dev.session.launchHarness',
        'dev.session.launchDefault',
        'dev.session.resumeHarness',
        'dev.session.cancelHarness',
        'dev.session.events',
        // ADR 0012: agent memory proposals land pending through the harness
        // register, bound to the session's own workspace.
        'dev.memory.propose',
        'dev.worktree.list',
        'dev.worktree.create',
        'dev.worktree.archive',
        'dev.worktree.unarchive',
        'dev.worktree.lease',
        'dev.worktree.releaseLease',
        'dev.worktree.mergePlan',
        'dev.worktree.mergeCommit',
        'dev.worktree.cleanupPlan',
        'dev.worktree.cleanupCommit',
        'dev.worktree.cleanupResume',
        'dev.device.list',
        'dev.browser.lanes',
        // #424 runtime resources, usage, and cleanup policies.
        'dev.resources.snapshot',
        'dev.resources.processes',
        'dev.resources.ports',
        'dev.resources.metrics',
        'dev.resources.retainedData',
        'dev.resources.usage',
        'dev.resources.stopPlan',
        'dev.resources.stopCommit',
        'dev.cleanupPolicy.list',
        'dev.cleanupPolicy.createDraft',
        'dev.cleanupPolicy.approve',
        'dev.cleanupPolicy.disable',
        'dev.cleanupPolicy.evaluate',
      ] as const
      for (const operation of expectedProviders) {
        expect(providers).toContain(operation)
      }
      // Families whose owning slices have not landed stay typed-unavailable
      // with a documented reason, never fabricated successes.
      for (const operation of all) {
        if (typedUnavailable.includes(operation)) {
          expect(shell.currentHost().registration.unavailableReason[operation]).toContain(
            'no host adapter'
          )
        }
      }
      // #399: files/search and local git register with the composition; the
      // live worktree context gates each operation at dispatch time.
      expect(providers.some((operation) => operation.startsWith('dev.files.'))).toBe(true)
      expect(providers.some((operation) => operation.startsWith('dev.git.'))).toBe(true)
      // #399 residue: with the full-duplex gateway composed, the bulk-stream
      // grant operations (file-bytes-v1) are reachable providers too, so the
      // whole files family is served — nothing lingers typed-unavailable.
      expect(typedUnavailable.some((operation) => operation.startsWith('dev.files.'))).toBe(false)
      expect(typedUnavailable.some((operation) => operation.startsWith('dev.git.'))).toBe(false)
      // #423: the github family registers as reachable providers — none of
      // it may linger in the typed-unavailable tail.
      expect(typedUnavailable.some((operation) => operation.startsWith('dev.github.'))).toBe(false)
      // #424: resources/usage/cleanup-policy providers register on a verified
      // scope; listings without a bound supervision engine are truthful-empty
      // and destructive stops fail closed with `capability_unavailable`.
      expect(typedUnavailable.some((operation) => operation.startsWith('dev.resources.'))).toBe(
        false
      )
      expect(typedUnavailable.some((operation) => operation.startsWith('dev.cleanupPolicy.'))).toBe(
        false
      )
      // No sidecar: terminal stays typed-unavailable, not unknown.
      expect(typedUnavailable.some((operation) => operation.startsWith('dev.terminal.'))).toBe(true)
      // #31/#32: the harness substrate registers on a verified scope, and a
      // clean desktop reports truthful managed-Pi absence (no fabricated
      // installation, no manual Pi step required to reach `ready`).
      const harness = shell.currentHost().harness
      expect(harness).toBeDefined()
      expect(harness!.commands).toContain('dev.harness.managedPiInstall')
      expect(harness!.managedPi.status()).toMatchObject({
        state: 'absent',
        pinnedVersion: harness!.managedPi.pinnedVersion,
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('terminal operations register when the sidecar is present', async () => {
    const sidecar = {
      welcome: { pidStartIdentity: 'sidecar-test-identity' },
      setEvents: () => undefined,
      list: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      create: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      resize: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      signal: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      terminate: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      checkpoint: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      search: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      deleteHistory: () =>
        Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      attach: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
      detach: () => Promise.resolve({ ok: true, value: null }),
      acknowledge: () => Promise.resolve({ ok: true, value: null }),
      writeInput: () => Promise.resolve({ ok: false, code: 'unavailable', message: 'not running' }),
    }
    const shell = await boot({ sidecar })
    try {
      expect(shell.currentHost().terminal).toBeDefined()
      const { providers, typedUnavailable } = shell.currentHost().registration
      expect(providers).toContain('dev.terminal.create')
      expect(providers).toContain('dev.terminal.list')
      expect(typedUnavailable.some((operation) => operation.startsWith('dev.terminal.'))).toBe(
        false
      )
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('#424: without a bound engine, resource listings stay truthful-empty and stop fails closed', async () => {
    const shell = await boot()
    try {
      // No component manifest was composed in: no engine is held.
      expect(shell.currentHost().supervision).toBeUndefined()
      expect(shell.currentHost().supervisionRecords).toBeUndefined()
      const channel = await shell.openChannel()
      const processes = await channel.execute(commandFor('dev.resources.processes', SCOPE_A, {}))
      expect(processes).toMatchObject({ ok: true, value: { items: [] } })
      const snapshot = await channel.execute(commandFor('dev.resources.snapshot', SCOPE_A, {}))
      expect(snapshot).toMatchObject({
        ok: true,
        value: { processes: [], ports: [], metrics: [], retainedData: [] },
      })
      // The destructive stop path refuses closed: without the engine the
      // composition cannot prove process ownership, so it never signals.
      const stopped = await channel.execute(
        commandFor(
          'dev.resources.stopPlan',
          SCOPE_A,
          { processRecordId: 'record-invented', expectedGeneration: 1, reason: 'test' },
          { resource: { kind: 'process', id: 'record-invented', generation: 1 } }
        )
      )
      expect(stopped).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('#424: a composed manifest binds the engine — listings prove from the journal and stop delegates to it', async () => {
    const decoded = decodeComponentManifest({
      schemaVersion: 1,
      components: [
        {
          id: 'dev-runtime-sidecar',
          product: 'Dev Runtime sidecar (test)',
          version: '1.0.0',
          platform: 'universal',
          arch: 'universal',
          digestSha256: 'a'.repeat(64),
          signature: 'test-signature',
          compatibility: { minAppVersion: '0.0.1', maxAppVersion: '99.0.0' },
          installLocation: 'Resources/app/dev-runtime-sidecar',
          dataLocation: 'dev-runtime-sidecar',
          startupPhase: 0,
          dependsOn: [],
          healthProbe: { kind: 'process', intervalMs: 15_000, unhealthyAfterMs: 45_000 },
          protocol: null,
          rollbackTargetVersion: null,
          required: true,
        },
      ],
    })
    expect(decoded.ok).toBe(true)
    const signals: Array<{ pid: number; signal: string }> = []
    let identityProofs = 0
    let alive = false
    const scriptedAdapter: SupervisionAdapter = {
      async spawn() {
        alive = true
        return {
          identity: {
            pid: 4711,
            pidStartIdentity: 'start-4711',
            executableIdentity: '/exe/sidecar',
          },
          processGroup: 'pg-4711',
        }
      },
      async currentIdentity(pid) {
        identityProofs += 1
        if (!alive) return null
        return {
          pid,
          pidStartIdentity: 'start-4711',
          executableIdentity: '/exe/sidecar',
          processGroup: 'pg-4711',
        }
      },
      async probe() {
        return alive ? 'responsive' : 'unresponsive'
      },
      async signalIdentity(identity, signalName) {
        signals.push({ pid: identity.pid, signal: signalName })
        alive = false
      },
    }
    const shell = await boot({
      componentManifest: decoded.ok ? decoded.manifest : undefined,
      supervisionAdapter: scriptedAdapter,
      sampleProcesses: async (pids) =>
        pids.map((pid) => ({ pid, cpuSeconds: 1.25, residentBytes: 8 * 1024 * 1024 })),
      retainedData: () => [
        {
          id: 'ret-1',
          ownerId: 'proj-1',
          kind: 'dependency_template',
          byteLength: '4096',
          protected: false,
          observedAt: new Date().toISOString(),
        },
      ],
    })
    try {
      const host = shell.currentHost()
      expect(host.supervision).toBeDefined()
      expect(host.supervisionRecords).toBeDefined()
      // The engine starts the component through its adapter; the durable
      // journal records the launch under the composition's data dir.
      const started = await host.supervision!.start({
        componentId: 'dev-runtime-sidecar',
        idempotencyKey: 'composition-test',
      })
      expect(started).toMatchObject({ ok: true })
      if (!started.ok) return
      const recordId = started.value.processRecordId

      const channel = await shell.openChannel()
      const processes = await channel.execute(commandFor('dev.resources.processes', SCOPE_A, {}))
      expect(processes).toMatchObject({
        ok: true,
        value: {
          items: [
            {
              id: recordId,
              pid: 4711,
              startIdentity: 'start-4711',
              generation: 1,
              state: 'running',
            },
          ],
        },
      })
      // The snapshot pulls one bounded sample through the sampler seam and
      // reports the retained-data source verbatim.
      const snapshot = await channel.execute(commandFor('dev.resources.snapshot', SCOPE_A, {}))
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          retainedData: [{ id: 'ret-1', kind: 'dependency_template', byteLength: '4096' }],
        },
      })
      if (snapshot.ok) {
        expect(snapshot.value.metrics).toHaveLength(1)
        expect(snapshot.value.metrics[0]).toMatchObject({
          processRecordId: recordId,
          residentBytes: '8388608',
          confidence: 'measured',
        })
        // The first sample for an owner carries no cpuPercent (never 0).
        expect(snapshot.value.metrics[0]?.cpuPercent).toBeUndefined()
      }

      // Stop is a plan/commit pair bound to the envelope resource; the commit
      // delegates to the engine's public stop, which re-proves the launch
      // identity immediately before the signal (exactly one, to the owned PID).
      const planReply = await channel.execute(
        commandFor(
          'dev.resources.stopPlan',
          SCOPE_A,
          { processRecordId: recordId, expectedGeneration: 1, reason: 'composition test' },
          { resource: { kind: 'process', id: recordId, generation: 1 } }
        )
      )
      expect(planReply).toMatchObject({
        ok: true,
        value: { resource: { kind: 'process', id: recordId, generation: 1 } },
      })
      if (!planReply.ok) return
      const commitReply = await channel.execute(
        commandFor(
          'dev.resources.stopCommit',
          SCOPE_A,
          { planId: planReply.value.id, planDigest: planReply.value.digest },
          { resource: { kind: 'process', id: recordId, generation: 1 } }
        )
      )
      expect(commitReply).toMatchObject({
        ok: true,
        value: { id: recordId, pid: 4711, state: 'exited' },
      })
      expect(signals).toEqual([{ pid: 4711, signal: 'SIGTERM' }])
      // The ownership re-proof plus the exit observation both ran.
      expect(identityProofs).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('#185: the packaged entry loader resolves a fixture bundle and the composition boots the one supervisor', async () => {
    const bundle = makeFixtureAppBundle()
    try {
      const entryDir = join(bundle, 'Contents/Resources/app')
      // The entry directory resolves its own bundle two levels up; a repo-style
      // dev-run directory never mistakes itself for a bundle.
      expect(findRunningAppBundle(entryDir)).toBe(bundle)
      expect(findRunningAppBundle(join(tmpdir(), 'adea-dev-run/src/bun'))).toBeNull()

      const loaded = loadPackagedManifestForEntry(entryDir)
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) return
      expect(loaded.appBundle).toBe(bundle)
      const sidecar = loaded.manifest.components.find((c) => c.id === 'dev-runtime-sidecar')
      expect(sidecar).toBeDefined()
      // Strict decode over real bundled bytes: the manifest digest is the
      // artifact's actual SHA-256, and the version identity comes from the
      // bundle's own version.json.
      expect(sidecar?.digestSha256).toBe(
        createHash('sha256')
          .update(readFileSync(join(bundle, 'Contents/Resources/app/dev-runtime-sidecar/entry.js')))
          .digest('hex')
      )
      expect(sidecar?.version).toBe('9.9.9')

      // The composition, built exactly as bun/index.ts wires it with the
      // loaded manifest, holds the engine and serves the listing from its
      // journal joined against the live snapshot.
      const shell = await boot({
        componentManifest: loaded.manifest,
        supervisionAdapter: scriptedSupervisionAdapter(),
        sampleProcesses: async (pids) =>
          pids.map((pid) => ({ pid, cpuSeconds: 1.25, residentBytes: 8 * 1024 * 1024 })),
      })
      try {
        const host = shell.currentHost()
        expect(host.supervision).toBeDefined()
        expect(host.supervisionRecords).toBeDefined()
        const started = await host.supervision!.start({
          componentId: 'dev-runtime-sidecar',
          idempotencyKey: 'fixture-boot',
        })
        expect(started).toMatchObject({ ok: true })
        if (!started.ok) return
        const channel = await shell.openChannel()
        const processes = await channel.execute(commandFor('dev.resources.processes', SCOPE_A, {}))
        expect(processes).toMatchObject({
          ok: true,
          value: {
            items: [{ id: started.value.processRecordId, pid: 4711, state: 'running' }],
          },
        })
      } finally {
        rmSync(shell.dataDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(bundle.slice(0, bundle.lastIndexOf('/Adea-fixture.app')), {
        recursive: true,
        force: true,
      })
    }
  })

  test('#185: a dev run loads no packaged manifest and keeps the truthful no-supervision composition', async () => {
    // No .app two levels up: the loader reports absence typed, without
    // throwing, and the shell boots exactly as before the #185 wiring.
    const absent = loadPackagedManifestForEntry(join(tmpdir(), 'adea-dev-run/src/bun'))
    expect(absent).toMatchObject({ ok: false, appBundle: null })
    const shell = await boot()
    try {
      expect(shell.currentHost().supervision).toBeUndefined()
      expect(shell.currentHost().supervisionRecords).toBeUndefined()
      const channel = await shell.openChannel()
      const processes = await channel.execute(commandFor('dev.resources.processes', SCOPE_A, {}))
      expect(processes).toMatchObject({ ok: true, value: { items: [] } })
      // The destructive stop path still fails closed without an engine.
      const stopped = await channel.execute(
        commandFor(
          'dev.resources.stopPlan',
          SCOPE_A,
          { processRecordId: 'record-invented', expectedGeneration: 1, reason: 'test' },
          { resource: { kind: 'process', id: 'record-invented', generation: 1 } }
        )
      )
      expect(stopped).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('#185: a bundle with missing or non-artifact install entries fails closed to no supervision', async () => {
    // A found bundle whose launcher label does not resolve refuses the whole
    // manifest — it never describes an artifact the bundle does not contain.
    const missingLauncher = makeFixtureAppBundle({ omit: 'launcher' })
    const missing = loadPackagedManifestForEntry(join(missingLauncher, 'Contents/Resources/app'))
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.appBundle).toBe(missingLauncher)
      expect(missing.reason).toContain('Contents/MacOS/launcher')
    }
    rmSync(missingLauncher.slice(0, missingLauncher.lastIndexOf('/Adea-fixture.app')), {
      recursive: true,
      force: true,
    })

    // An install label resolving to a directory is not an artifact either.
    const directoryBundle = makeFixtureAppBundle({ sidecarIsDirectory: true })
    const directory = loadPackagedManifestForEntry(join(directoryBundle, 'Contents/Resources/app'))
    expect(directory.ok).toBe(false)
    if (!directory.ok) expect(directory.reason).toContain('is not a regular file')
    rmSync(directoryBundle.slice(0, directoryBundle.lastIndexOf('/Adea-fixture.app')), {
      recursive: true,
      force: true,
    })

    // Both failures map to the entry's one degraded decision: no manifest is
    // composed in, no engine is held — truthful absence, never fabricated state.
    const shell = await boot()
    try {
      expect(shell.currentHost().supervision).toBeUndefined()
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('a signed-out shell serves the device-local guest scope; foreign scopes still fail', async () => {
    const shell = await boot({ unbound: true })
    try {
      // No cloud binding exists, but the shell owns a device-local guest
      // scope minted at first boot: the Dev Runtime is fully live with no
      // account, and dispatch under the guest scope succeeds.
      expect(shell.identity.identityKind()).toBe('guest')
      const guestScope = shell.identity.currentScope()
      const channel = await shell.openChannel()
      const served = await channel.execute(
        commandFor('dev.project.list', guestScope, { limit: 10 })
      )
      expect(served.ok).toBe(true)

      // The renderer can never self-assert a scope: anything but the exact
      // active scope is refused before capability checks or dispatch.
      const foreign = await channel.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(foreign).toMatchObject({ ok: false, error: { code: 'channel_unauthorized' } })

      // The trust gate refuses a handshake from a foreign origin before the
      // bootstrap token is examined: loopback presence is not authority.
      expect(() => shell.authority.handshake({}, { trusted: false })).toThrow(
        'untrusted client origin'
      )
      // Binding with a credential the cloud refuses fails closed, and the
      // guest scope stays the active identity.
      const refusedVerifier = fakeCloudVerifier({ unreachable: true })
      const strict = createDesktopIdentityAuthority({
        dataDir: shell.dataDir + '-2',
        verifier: refusedVerifier,
      })
      await expect(strict.bind({ session: SESSION, claimed: SCOPE_A })).rejects.toMatchObject({
        code: 'runtime_node_unavailable',
      })
      expect(strict.identityKind()).toBe('guest')

      // The device-local identity persists: a fresh authority over the same
      // data directory reads the same scope, so projects and history keyed
      // to it survive restarts. A different data directory mints a different
      // one.
      const reopened = createDesktopIdentityAuthority({
        dataDir: shell.dataDir,
        verifier: refusedVerifier,
      })
      expect(reopened.currentScope()).toEqual(guestScope)
      expect(
        createDesktopIdentityAuthority({
          dataDir: shell.dataDir + '-3',
          verifier: refusedVerifier,
        }).currentScope().accountId
      ).not.toBe(guestScope.accountId)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
      rmSync(shell.dataDir + '-2', { recursive: true, force: true })
      rmSync(shell.dataDir + '-3', { recursive: true, force: true })
    }
  })

  test('caller-selected scope is rejected before capability checks and dispatch', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      // The capability set is frame-enforced (the renderer cannot vary it);
      // the gate owns scope. A foreign scope is refused before any provider
      // runs: dev.project.get with an unknown project would answer not_found
      // under dispatch, so channel_unauthorized proves the ordering.
      const foreign = '00000000-0000-4000-8000-000000000abc'
      const scopeOnly = await channel.execute(
        commandFor(
          'dev.project.get',
          OTHER_SCOPE,
          { projectId: foreign },
          { resource: { kind: 'project', id: foreign, generation: 1 } }
        )
      )
      expect(scopeOnly).toMatchObject({ ok: false, error: { code: 'channel_unauthorized' } })
      // A forged runtime-node id is just a scope mismatch.
      const nodeSwap = await channel.execute(
        commandFor('dev.project.list', { ...SCOPE_A, runtimeNodeId: OTHER_SCOPE.runtimeNodeId }, {})
      )
      expect(nodeSwap).toMatchObject({ ok: false, error: { code: 'channel_unauthorized' } })
      // The same operation under the bound scope reaches the provider and
      // answers not_found — the earlier refusal was the gate, not dispatch.
      const dispatched = await channel.execute(
        commandFor(
          'dev.project.get',
          SCOPE_A,
          { projectId: foreign },
          { resource: { kind: 'project', id: foreign, generation: 1 } }
        )
      )
      expect(dispatched).toMatchObject({ ok: false, error: { code: 'not_found' } })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('ineligible and revoked runtime nodes fail every privileged operation', async () => {
    let revoked = false
    let unreachable = false
    const shell = await boot({
      verifier: {
        async verifySession() {
          return [SCOPE_A.workspaceId]
        },
        async verifyNodeEligibility() {
          if (revoked) {
            throw new ChannelRejection('runtime_node_revoked', 'node was revoked', 403)
          }
          if (unreachable) {
            throw new ChannelRejection('runtime_node_unavailable', 'cloud unreachable', 503, true)
          }
        },
      },
    })
    try {
      const channel = await shell.openChannel()
      const ok = await channel.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(ok.ok).toBe(true)

      revoked = true
      const rejected = await channel.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(rejected).toMatchObject({ ok: false, error: { code: 'runtime_node_revoked' } })

      revoked = false
      unreachable = true
      const unavailable = await channel.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(unavailable).toMatchObject({ ok: false, error: { code: 'runtime_node_unavailable' } })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('a workspace switch revokes stale channels and rebinds authority', async () => {
    const shell = await boot({
      verifier: fakeCloudVerifier({ workspaces: [SCOPE_A.workspaceId, SCOPE_B.workspaceId] }),
    })
    try {
      const first = await shell.openChannel()
      const ok = await first.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(ok.ok).toBe(true)
      const aProject: Project = {
        id: randomUUID(),
        scope: SCOPE_A,
        repoIds: [],
        lifecycle: 'ready',
        version: 1,
      }
      shell.currentHost().projectSession!.upsertProject(aProject)
      expect(await first.execute(commandFor('dev.project.list', SCOPE_A, {}))).toMatchObject({
        ok: true,
        value: { items: [aProject] },
      })

      // Re-bind under a different workspace: the composition revokes every
      // channel minted under the previous binding.
      await shell.bind(SCOPE_B)
      const stale = await first.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(stale).toMatchObject({ ok: false, error: { code: 'channel_unauthenticated' } })

      // A fresh handshake under the new binding serves the new scope only.
      const second = await shell.openChannel()
      const rebound = await second.execute(commandFor('dev.project.list', SCOPE_B, {}))
      expect(rebound.ok).toBe(true)
      const bProject: Project = {
        id: randomUUID(),
        scope: SCOPE_B,
        repoIds: [],
        lifecycle: 'ready',
        version: 1,
      }
      shell.currentHost().projectSession!.upsertProject(bProject)
      expect(await second.execute(commandFor('dev.project.list', SCOPE_B, {}))).toMatchObject({
        ok: true,
        value: { items: [bProject] },
      })
      const oldScope = await second.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(oldScope).toMatchObject({ ok: false, error: { code: 'channel_unauthorized' } })

      await shell.bind(SCOPE_A)
      const third = await shell.openChannel()
      expect(await third.execute(commandFor('dev.project.list', SCOPE_A, {}))).toMatchObject({
        ok: true,
        value: { items: [aProject] },
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('dev.project.unbind is gated by the manage capability and the project resource binding', async () => {
    const shell = await boot({ verifier: fakeCloudVerifier({ workspaces: [SCOPE_A.workspaceId] }) })
    try {
      const channel = await shell.openChannel()
      const project: Project = {
        id: randomUUID(),
        scope: SCOPE_A,
        repoIds: [],
        lifecycle: 'ready',
        version: 1,
      }
      shell.currentHost().projectSession!.upsertProject(project)
      const body = { projectId: project.id, expectedVersion: project.version }
      const resource = { kind: 'project', id: project.id, generation: project.version } as const

      // A read-only capability set does not authorize removing a binding.
      const denied = await channel.execute(
        commandFor('dev.project.unbind', SCOPE_A, body, {
          capabilities: ['dev.project.read'],
          resource,
        } as Partial<DevCommand>)
      )
      expect(denied).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
      // The project resource binding is mandatory and must name the body's project.
      const unbound = await channel.execute(commandFor('dev.project.unbind', SCOPE_A, body))
      expect(unbound).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
      const foreign = await channel.execute(
        commandFor('dev.project.unbind', SCOPE_A, body, {
          resource: { ...resource, id: randomUUID() },
        } as Partial<DevCommand>)
      )
      expect(foreign).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
      expect(await channel.execute(commandFor('dev.project.list', SCOPE_A))).toMatchObject({
        ok: true,
        value: { items: [project] },
      })

      expect(
        await channel.execute(
          commandFor('dev.project.unbind', SCOPE_A, body, { resource } as Partial<DevCommand>)
        )
      ).toMatchObject({ ok: true, value: project })
      expect(await channel.execute(commandFor('dev.project.list', SCOPE_A))).toMatchObject({
        ok: true,
        value: { items: [] },
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('dev.project.clone is capability-gated, resource-free, and binds a managed bare clone', async () => {
    const shell = await boot({ verifier: fakeCloudVerifier({ workspaces: [SCOPE_A.workspaceId] }) })
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'adea-clone-origin-')))
    try {
      const origin = join(fixtureRoot, 'origin.git')
      const seed = join(fixtureRoot, 'seed')
      mkdirSync(seed)
      const gitIn = (cwd: string, args: string[]) =>
        Bun.spawnSync(['git', ...args], {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Adea Tests',
            GIT_AUTHOR_EMAIL: 'adea@example.com',
            GIT_COMMITTER_NAME: 'Adea Tests',
            GIT_COMMITTER_EMAIL: 'adea@example.com',
            GIT_TERMINAL_PROMPT: '0',
          },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60_000,
        })
      gitIn(fixtureRoot, ['init', '--bare', '-b', 'main', origin])
      gitIn(seed, ['init', '-b', 'main'])
      gitIn(seed, ['config', 'core.hooksPath', '/dev/null'])
      writeFileSync(join(seed, 'README.md'), '# remote only\n')
      gitIn(seed, ['add', '.'])
      gitIn(seed, ['commit', '-m', 'initial'])
      gitIn(seed, ['push', origin, 'main'])

      const channel = await shell.openChannel()
      const projectId = randomUUID()
      const body = { projectId, remoteUrl: `file://${origin}`, mode: 'managed' }
      // Read-only capabilities never clone; a resource binding is refused.
      const denied = await channel.execute(
        commandFor('dev.project.clone', SCOPE_A, body, {
          capabilities: ['dev.project.read'],
        } as Partial<DevCommand>)
      )
      expect(denied.ok).toBe(false)
      const halfGranted = await channel.execute(
        commandFor('dev.project.clone', SCOPE_A, body, {
          capabilities: ['dev.project.manage'],
        } as Partial<DevCommand>)
      )
      expect(halfGranted.ok).toBe(false)
      const withResource = await channel.execute(
        commandFor('dev.project.clone', SCOPE_A, body, {
          resource: { kind: 'project', id: projectId, generation: 1 },
        } as Partial<DevCommand>)
      )
      expect(withResource.ok).toBe(false)
      expect(await channel.execute(commandFor('dev.project.list', SCOPE_A))).toMatchObject({
        ok: true,
        value: { items: [] },
      })

      const cloned = await channel.execute(commandFor('dev.project.clone', SCOPE_A, body))
      expect(cloned).toMatchObject({
        ok: true,
        value: { id: projectId, repos: [{ layout: 'bare_managed' }], lifecycle: 'ready' },
      })
      const repos = await channel.execute(commandFor('dev.repo.list', SCOPE_A, { projectId }))
      expect(repos).toMatchObject({
        ok: true,
        value: { items: [{ kind: 'git', layout: 'bare_managed', projectIds: [projectId] }] },
      })
      const repo = (repos as { value: { items: { canonicalRoot: string; id: string }[] } }).value
        .items[0]!
      expect(repo.canonicalRoot).toBe(
        join(realpathSync(shell.dataDir), 'dev-runtime', 'managed-repos', `${repo.id}.git`)
      )
      // No primary checkout record: a remote-only project has worktrees only.
      expect(
        await channel.execute(commandFor('dev.worktree.list', SCOPE_A, { projectId }))
      ).toMatchObject({ ok: true, value: { items: [] } })
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('sign-out returns to the same device-local guest scope and revokes cloud channels', async () => {
    // Boot signed-out first so the pre-bind guest scope is observable: the
    // identity the surface falls back to must be the very scope the user's
    // signed-out work was keyed to.
    const shell = await boot({ unbound: true })
    try {
      const guestScope = shell.identity.currentScope()
      await shell.bind(SCOPE_A)
      expect(shell.identity.identityKind()).toBe('cloud')

      const cloudChannel = await shell.openChannel()
      await shell.identity.unbind('owner sign-out')
      // The composition revoked every channel minted under the cloud
      // binding: reconnects re-handshake instead of inheriting the old
      // authority.
      const stale = await cloudChannel.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(stale).toMatchObject({ ok: false, error: { code: 'channel_unauthenticated' } })
      // The active identity is the SAME guest scope as before sign-in — the
      // signed-out surface is alive, not stranded.
      expect(shell.identity.identityKind()).toBe('guest')
      expect(shell.identity.currentScope()).toEqual(guestScope)
      const guestChannel = await shell.openChannel()
      const served = await guestChannel.execute(
        commandFor('dev.project.list', guestScope, { limit: 10 })
      )
      expect(served.ok).toBe(true)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('composition grant authorities require issuance-backed approvals', async () => {
    const shell = await boot()
    try {
      const dir = join(shell.dataDir, 'authorized-root')
      mkdirSync(dir, { recursive: true })
      // The composed roots authority carries the mandatory verifier: a
      // structural approval without issuance is rejected.
      expect(() =>
        shell.currentHost().roots.mint({
          scope: SCOPE_A,
          label: 'Repo',
          kind: 'repository',
          absolutePath: dir,
          approval: {
            method: 'owner_dialog',
            reference: 'invented-by-caller',
            scope: SCOPE_A,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        })
      ).toThrow('never issued')
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('typed-unavailable operations refuse with documented capability results', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const unavailable = shell.currentHost().registration.typedUnavailable
      expect(unavailable.length).toBeGreaterThan(0)
      // dev.project.scan/import/create gained real providers (#398) and the
      // github family registered too (#423); the sample of a documented
      // typed refusal moves with whatever the registry still lacks.
      // dev.terminal.list: null resource, all-optional body — the envelope
      // decodes and the typed-unavailable provider names the missing host
      // adapter without any other wiring.
      const sample = unavailable.find((operation) => operation === 'dev.terminal.list')!
      const reply = await channel.execute(commandFor(sample, SCOPE_A, {}))
      expect(reply).toMatchObject({
        ok: false,
        error: { code: 'capability_unavailable' },
      })
      if (!reply.ok) {
        expect(reply.error.message).toContain(sample)
      }
      // A provider operation answers successfully on the bound scope.
      const providerReply = await channel.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(providerReply).toMatchObject({ ok: true })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('session creation is generation-fenced and publishes canonical events', async () => {
    const events: Array<{ event: string; payload: unknown }> = []
    const shell = await boot({
      publish: (event, payload) => events.push({ event, payload }),
    })
    try {
      const channel = await shell.openChannel()
      // No worktree exists on this node: the fail-closed creation hook
      // refuses a session bound to an unknown worktree.
      const refused = await channel.execute(
        commandFor('dev.session.create', SCOPE_A, {
          projectId: randomUUID(),
          repoId: randomUUID(),
          worktreeId: randomUUID(),
        })
      )
      expect(refused).toMatchObject({ ok: false, error: { code: 'not_found' } })
      expect(events).toHaveLength(0)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })
})

describe('production worktrees (ADR 0011)', () => {
  test('one composed worktree service: adopt yields a primary record sessions bind to', async () => {
    const shell = await boot()
    const workspace = mkdtempSync(join(tmpdir(), 'adea-composition-ws-'))
    try {
      const host = shell.currentHost()
      // The composition itself constructs the one worktree service.
      expect(host.worktreeService).toBeDefined()
      expect(host.worktrees.commands).toContain('dev.worktree.rename')
      expect(host.worktrees.commands).toContain('dev.worktree.diffSummary')
      expect(host.registration.providers).toContain('dev.worktree.rename')
      expect(host.registration.providers).toContain('dev.worktree.diffSummary')

      // A real checkout on a non-main branch under an authorized root.
      const repoPath = join(realpathSync(workspace), 'app')
      mkdirSync(repoPath)
      const runGit = (args: string[]) =>
        Bun.spawnSync(['git', ...args], {
          cwd: repoPath,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Adea Tests',
            GIT_AUTHOR_EMAIL: 'adea@example.com',
            GIT_COMMITTER_NAME: 'Adea Tests',
            GIT_COMMITTER_EMAIL: 'adea@example.com',
          },
          timeout: 60_000,
        })
      runGit(['init', '-q', '-b', 'main'])
      runGit(['config', 'core.hooksPath', '/dev/null'])
      writeFileSync(join(repoPath, 'README.md'), '# app\n')
      runGit(['add', '.'])
      runGit(['commit', '-qm', 'initial'])
      runGit(['checkout', '-q', '-b', 'feature/sidebar'])

      const approval = {
        method: 'owner_dialog' as const,
        reference: `composition-root-${randomUUID()}`,
        scope: SCOPE_A,
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
      createOwnerApprovalVerifier({ dataDir: shell.dataDir }).recordIssuance(
        approval,
        SCOPE_A,
        'authorize a root bookmark'
      )
      const bookmark = host.roots.mint({
        scope: SCOPE_A,
        label: 'Workspace',
        kind: 'repository',
        absolutePath: workspace,
        approval,
      })
      const projectId = randomUUID()
      const repoId = randomUUID()
      host.projectSession!.upsertProject({
        id: projectId,
        scope: SCOPE_A,
        repoIds: [repoId],
        repos: [{ repoId, rootBookmarkId: bookmark.id, canonicalRoot: repoPath }],
        lifecycle: 'ready',
        version: 1,
      })

      const channel = await shell.openChannel()
      const adopted = await channel.execute(
        commandFor(
          'dev.repo.adopt',
          SCOPE_A,
          { repoId, rootBookmarkId: bookmark.id, expectedVersion: 1 },
          { resource: { kind: 'repository', id: repoId, generation: 1 } }
        )
      )
      expect(adopted).toMatchObject({ ok: true })

      const listed = await channel.execute(commandFor('dev.worktree.list', SCOPE_A, { repoId }))
      expect(devOperationDecoders['dev.worktree.list'].reply(listed)).toBeTruthy()
      if (!listed.ok) throw new Error('list failed')
      const items = (listed.value as { items: Worktree[] }).items
      expect(items).toHaveLength(1)
      const primary = items[0]!
      expect(primary).toMatchObject({
        kind: 'primary',
        branchRef: 'refs/heads/feature/sidebar',
        headRef: 'refs/heads/feature/sidebar',
        projectId,
        repoId,
      })

      // validateSessionCreation accepts the primary worktree id.
      const session = await channel.execute(
        commandFor('dev.session.create', SCOPE_A, {
          projectId,
          repoId,
          worktreeId: primary.id,
        })
      )
      expect(session).toMatchObject({ ok: true })

      const resource = { kind: 'worktree', id: primary.id, generation: primary.generation }
      // Rename refuses the primary (typed) and an unbound command.
      const renamePrimary = await channel.execute(
        commandFor(
          'dev.worktree.rename',
          SCOPE_A,
          { worktreeId: primary.id, expectedVersion: primary.version, title: 'Main' },
          { resource }
        )
      )
      expect(renamePrimary).toMatchObject({ ok: false, error: { code: 'invalid_state' } })
      const renameUnbound = await channel.execute(
        commandFor('dev.worktree.rename', SCOPE_A, {
          worktreeId: primary.id,
          expectedVersion: primary.version,
          title: 'Main',
        })
      )
      expect(renameUnbound).toMatchObject({ ok: false })
      // Deny by default: a missing capability refuses before dispatch.
      const renameUnderCapable = await channel.execute(
        commandFor(
          'dev.worktree.rename',
          SCOPE_A,
          { worktreeId: primary.id, expectedVersion: primary.version, title: 'Main' },
          { resource, capabilities: ['dev.worktree.read'] as never }
        )
      )
      expect(renameUnderCapable).toMatchObject({ ok: false })

      // Diff summary: counts only, decoded strictly.
      writeFileSync(join(repoPath, 'README.md'), '# app\nmore\n')
      const diff = await channel.execute(
        commandFor('dev.worktree.diffSummary', SCOPE_A, { worktreeIds: [primary.id] })
      )
      expect(devOperationDecoders['dev.worktree.diffSummary'].reply(diff)).toBeTruthy()
      expect(diff).toMatchObject({
        ok: true,
        value: [{ worktreeId: primary.id, added: 1, removed: 0, filesChanged: 1 }],
      })
      const diffUnknown = await channel.execute(
        commandFor('dev.worktree.diffSummary', SCOPE_A, { worktreeIds: [randomUUID()] })
      )
      expect(diffUnknown).toMatchObject({ ok: false, error: { code: 'not_found' } })
      const diffBound = await channel.execute(
        commandFor('dev.worktree.diffSummary', SCOPE_A, { worktreeIds: [primary.id] }, { resource })
      )
      expect(diffBound).toMatchObject({ ok: false })
      const diffUnderCapable = await channel.execute(
        commandFor(
          'dev.worktree.diffSummary',
          SCOPE_A,
          { worktreeIds: [primary.id] },
          { capabilities: ['dev.worktree.read'] as never }
        )
      )
      expect(diffUnderCapable).toMatchObject({ ok: false })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
