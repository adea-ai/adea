// Harness-in-PTY spawn path and observed-exit discipline (#400 residue).
//
// Pins the second deferred #400 residue: a launch with the `attachTerminal`
// intent spawns the host-resolved harness executable as the PTY child of a
// NEW terminal bound to the runtime session (argv spawn pre-`starting`, the
// terminal register's own spawn patterns), binds the run to the terminal
// id/generation, and derives later status ONLY from sidecar-OBSERVED
// terminations:
// - a spawn failure refuses the launch typed before any run record exists;
// - an attachTerminal launch on a host without a terminal runtime refuses
//   `capability_unavailable`;
// - the observed exit code maps through the canonical machine (0 → completed,
//   non-zero → failed, null/signalled → disconnected — a signal is never an
//   exit status), never overwrites a terminal state, and demotes an illegal
//   edge to `disconnected` while preserving the observed code in the detail;
// - a notice naming another terminal or generation never moves the run.
// Full-stack tests run the real in-process sidecar over a fake PTY; the
// register-level tests inject the exit subscription and the clock. No real
// harness process is ever spawned.
import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type RuntimeSession,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import { createInMemoryVaultKeyStore } from '../shell/src/dev-runtime/vault'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import { registerHarnessRuntime } from '../shell/src/dev-runtime/harness/register'
import type {
  ManagedPiDriver,
  ManagedPiStatus,
} from '../shell/src/dev-runtime/harness/managed-pi-driver'
import { createManagedPiDriver } from '../shell/src/dev-runtime/harness/managed-pi-driver'
import {
  connectSidecarClient,
  type SidecarClient,
} from '../shell/src/dev-runtime/terminal/sidecar/client'
import {
  createSidecarService,
  newSidecarCredential,
} from '../shell/src/dev-runtime/terminal/sidecar/service'
import type { ByteDuplex } from '../shell/src/dev-runtime/terminal/sidecar/protocol'
import { TERMINAL_LIMITS } from '../shell/src/dev-runtime/terminal/limits'
import { createFakePtyAdapter } from './fixtures/fake-pty'
import { createLoopbackPair } from './fixtures/loopback-duplex'
import type { WorktreeService } from '../shell/src/dev-runtime/worktrees/service'

const SHELL_HOST = '127.0.0.1'
const SHELL_PORT = 4803
const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`

const SCOPE_A: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-ptyspawn-0000-0001',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}

const PINNED_ARCHIVE = new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')
const DEFAULT_ARCHIVE = () => Promise.resolve(PINNED_ARCHIVE)

const WORKTREE_ID = '00000000-0000-4000-8000-0000000000bb'
const PROJECT_ID = '00000000-0000-4000-8000-0000000000aa'
const REPO_ID = '00000000-0000-4000-8000-0000000000ab'
const WORKTREE_ROOT = '/tmp/adea-pty-spawn-worktree'

function fakeCloudVerifier(): DesktopIdentityVerifier {
  return {
    async verifySession() {
      return [SCOPE_A.workspaceId]
    },
    async verifyNodeEligibility() {
      return
    },
  }
}

/** Worktree stand-in whose canonical roots satisfy terminal creation. */
const fakeWorktreeService = {
  getWorktree: (scope: Scope, worktreeId: string) => ({
    id: worktreeId,
    scope,
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    canonicalRoot: WORKTREE_ROOT,
    rootIdentity: { device: '1', inode: '2', mtimeNs: '3', size: '4' },
    generation: 1,
    lifecycle: 'ready',
  }),
} as unknown as WorktreeService

/** Boots the full composition with a real in-process sidecar + fake PTY. */
async function boot(options: { withSidecar?: boolean } = {}): Promise<{
  authority: ReturnType<typeof createChannelAuthority>
  host(): DevRuntimeHost
  dataDir: string
  ptyProcesses(): ReturnType<typeof createFakePtyAdapter>['processes']
  ptySpawnInputs(): ReturnType<typeof createFakePtyAdapter>['spawnInputs']
  failNextSpawnWith(code: 'spawn_failed' | 'unsupported_capability', message: string): void
  openChannel(): Promise<{
    execute(command: DevCommand): Promise<DevReply>
  }>
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-harness-ptyspawn-'))
  const stateDir = join(dataDir, 'desktop-state')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const deviceKey = randomBytes(32)
  writeFileSync(join(stateDir, 'device.key'), deviceKey, { mode: 0o600 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deviceKey, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(SESSION), 'utf8'), cipher.final()])
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  writeFileSync(join(stateDir, 'session.sealed'), sealed.toString('base64'), { mode: 0o600 })
  const identity = createDesktopIdentityAuthority({ dataDir, verifier: fakeCloudVerifier() })
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
  await identity.bind({ session: SESSION, claimed: SCOPE_A })

  let sidecar: SidecarClient | undefined
  const fake = createFakePtyAdapter()
  if (options.withSidecar !== false) {
    const credential = newSidecarCredential()
    const service = createSidecarService({
      runtimeRoot: join(dataDir, 'dev-runtime'),
      ptyAdapter: fake.adapter,
      sidecarVersion: '1.0.0-test',
      credential,
      executableIdentity: 'sidecar@ptyspawn-test',
      pidStartIdentity: 'ptyspawn-test-identity',
      managerLimits: { ...TERMINAL_LIMITS, ringMaxBytes: 4096, subscriberHighWaterBytes: 1024 },
    })
    const [clientSide, serverSide]: [ByteDuplex, ByteDuplex] = createLoopbackPair()
    service.handleConnection(serverSide)
    const connected = await connectSidecarClient({
      duplex: clientSide,
      scope: SCOPE_A,
      credential: Buffer.from(credential).toString('base64url'),
      nonce: randomUUID(),
    })
    if (!connected.ok) throw new Error('sidecar connect failed')
    sidecar = connected.client
  }

  const host = createDevRuntimeHost({
    credentialStore: createInMemoryVaultKeyStore(),
    authority,
    gateway,
    dataDir,
    scope: identity.currentScope(),
    identity,
    approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    ...(sidecar ? { sidecar } : {}),
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    worktreeService: fakeWorktreeService,
    managedPi: createManagedPiDriver({
      scope: SCOPE_A,
      dataDir,
      installRoot: join(dataDir, 'managed-pi-install'),
      resolvePinnedArchive: DEFAULT_ARCHIVE,
    }),
  })
  mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })
  return {
    authority,
    host: () => host,
    dataDir,
    ptyProcesses: () => fake.processes,
    ptySpawnInputs: () => fake.spawnInputs,
    failNextSpawnWith: (code, message) => fake.failNextSpawnWith(code, message),
    async openChannel() {
      const handshakeReply = authority.handshake(
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
      if (!handshakeReply.ok) throw new Error('handshake failed')
      const secret = Buffer.from(handshakeReply.clientSecret, 'base64url')
      const channelId = handshakeReply.channelId
      const clientCredentialId = handshakeReply.clientCredentialId
      return {
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

function sessionResource(session: { id: string; generation: number }) {
  return { kind: 'runtime_session', id: session.id, generation: session.generation }
}

function okValue(reply: DevReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`expected ok reply: ${JSON.stringify(reply.error)}`)
  return reply.value as Record<string, unknown>
}

function errorOf(reply: DevReply): { code: string; message: string } {
  if (reply.ok) throw new Error('expected error reply')
  return reply.error as { code: string; message: string }
}

async function sessionReady(
  shell: Awaited<ReturnType<typeof boot>>,
  channel: Awaited<ReturnType<ReturnType<typeof boot>['openChannel']>>
): Promise<{ id: string; generation: number }> {
  shell.host().projectSession?.upsertProject({
    id: PROJECT_ID,
    scope: SCOPE_A,
    name: 'PTY Spawn Project',
    groupIds: [],
    repoIds: [REPO_ID],
    lifecycle: 'ready',
    version: 1,
  })
  return okValue(
    await channel.execute(
      commandFor('dev.session.create', SCOPE_A, {
        projectId: PROJECT_ID,
        repoId: REPO_ID,
        worktreeId: WORKTREE_ID,
      })
    )
  ) as unknown as { id: string; generation: number }
}

async function installManagedPi(
  channel: Awaited<ReturnType<ReturnType<typeof boot>['openChannel']>>
): Promise<void> {
  okValue(await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {})))
}

/** Re-fetches the canonical session (the launch bumps its generation).
 * `dev.session.list` carries no resource binding, so it observes the current
 * record without a generation guess. */
async function currentSession(
  channel: Awaited<ReturnType<ReturnType<typeof boot>['openChannel']>>,
  id: string
): Promise<{ id: string; generation: number }> {
  const page = okValue(
    await channel.execute(commandFor('dev.session.list', SCOPE_A, {}))
  ) as unknown as { items: Array<{ id: string; generation: number }> }
  const found = page.items.find((entry) => entry.id === id)
  if (!found) throw new Error(`session ${id} disappeared from the projection`)
  return found
}

function launchCommand(
  session: { id: string; generation: number },
  installationId: string,
  options: { initialPrompt?: string; attachTerminal?: boolean } = {}
): DevCommand {
  return commandFor(
    'dev.session.launchHarness',
    SCOPE_A,
    {
      runtimeSessionId: session.id,
      expectedGeneration: session.generation,
      harnessInstallationId: installationId,
      agentProfileId: 'profile-1',
      agentProfileVersion: 1,
      ...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {}),
      ...(options.attachTerminal !== undefined ? { attachTerminal: options.attachTerminal } : {}),
    },
    { resource: sessionResource(session) }
  )
}

function runEventsOf(shell: Awaited<ReturnType<typeof boot>>, sessionId: string) {
  return shell
    .host()
    .harness!.events.read(sessionId)
    .filter((event) => event.sourceEventId.startsWith('host:run-'))
}

/** Bounded wait for a predicate; the sidecar exit path crosses several async hops. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

describe('harness-in-PTY spawn through the sidecar (#400 residue)', () => {
  test('an attachTerminal launch spawns the harness executable and binds the run to the terminal', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      await installManagedPi(channel)
      const installationId = shell.host().harness!.managedPi.status().installationId!

      const launched = okValue(
        await channel.execute(launchCommand(session, installationId, { attachTerminal: true }))
      ) as unknown as {
        id: string
        terminalId: string
        terminalGeneration: number
        state: string
      }
      // The run was born bound to the terminal: the harness process IS the
      // PTY child of a real terminal session.
      expect(launched.state).toBe('starting')
      expect(launched.terminalId).toBeString()
      expect(launched.terminalGeneration).toBe(1)

      // The spawned argv is the host-resolved executable identity in the
      // authorized worktree root — never renderer input, never a shell.
      expect(shell.ptyProcesses()).toHaveLength(1)
      const spawnInput = shell.ptySpawnInputs()[0]!
      expect(spawnInput.shell).toBe(shell.host().harness!.managedPi.status().executableIdentity!)
      expect(spawnInput.args).toEqual([])
      expect(spawnInput.cwd).toBe(WORKTREE_ROOT)

      // The run's terminal is a first-class terminal on the session.
      const terminals = okValue(
        await channel.execute(
          commandFor('dev.terminal.list', SCOPE_A, { runtimeSessionId: session.id })
        )
      ) as unknown as { items: Array<{ id: string; runtimeSessionId: string; state: string }> }
      expect(terminals.items).toHaveLength(1)
      expect(terminals.items[0]!.id).toBe(launched.terminalId)
      expect(terminals.items[0]!.state).toBe('running')

      // run.created/run.starting carry the spawn provenance (pre-starting
      // spawn, post-record events), and the stream shows the binding.
      const starting = runEventsOf(shell, session.id).find((event) => event.kind === 'run.starting')
      expect(starting).toBeDefined()
      expect(starting!.payload).toMatchObject({
        harnessRunId: launched.id,
        transport: 'pty_process',
        terminalId: launched.terminalId,
        terminalGeneration: 1,
      })

      // A repeat attachTerminal launch on the live identical run is
      // idempotent: the same run returns and no second process spawns.
      const relaunched = okValue(
        await channel.execute(
          launchCommand({ ...session, generation: session.generation + 1 }, installationId, {
            attachTerminal: true,
          })
        )
      ) as unknown as { id: string }
      expect(relaunched.id).toBe(launched.id)
      expect(shell.ptyProcesses()).toHaveLength(1)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a sidecar-observed zero exit completes the working run', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      await installManagedPi(channel)
      const installationId = shell.host().harness!.managedPi.status().installationId!
      const launched = okValue(
        await channel.execute(launchCommand(session, installationId, { attachTerminal: true }))
      ) as unknown as { id: string; terminalId: string }

      // Drive the canonical machine to working through the observed-status
      // gate, so the later exit edge is legal (completed from working).
      const live = await currentSession(channel, session.id)
      okValue(
        await channel.execute(
          commandFor(
            'dev.harness.runStatus',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: live.generation,
              harnessRunId: launched.id,
              state: 'working',
              source: 'host',
              detail: 'test observation',
            },
            { resource: sessionResource(live) }
          )
        )
      )

      // The sidecar OBSERVES the harness process exiting zero.
      shell.ptyProcesses()[0]!.exit(0)
      await waitFor(() => {
        const run = shell.host().harness!.history.get(launched.id)
        return run?.state === 'completed'
      })
      const run = shell.host().harness!.history.get(launched.id)!
      expect(run.state).toBe('completed')
      expect(run.finishedAt).toBeString()

      // The observed exit surfaced as canonical run/session events.
      const allEvents = shell.host().harness!.events.read(session.id)
      const kinds = allEvents.map((event) => event.kind)
      expect(kinds).toContain('run.completed')
      expect(kinds).toContain('session.completed')
      const exitEvent = allEvents.find((event) =>
        event.sourceEventId.startsWith(`host:run-exit:${launched.id}`)
      )
      expect(exitEvent!.payload).toMatchObject({
        terminalId: launched.terminalId,
        exitCode: 0,
      })
      const sessionExit = allEvents.find((event) =>
        event.sourceEventId.startsWith(`host:session-exit:${launched.id}`)
      )
      expect(sessionExit).toMatchObject({ kind: 'session.completed' })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a sidecar-observed non-zero exit fails the run; a spawn failure refuses the launch', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      await installManagedPi(channel)
      const installationId = shell.host().harness!.managedPi.status().installationId!
      const launched = okValue(
        await channel.execute(launchCommand(session, installationId, { attachTerminal: true }))
      ) as unknown as { id: string }

      // Non-zero observed exit while still starting: failed is a legal edge.
      shell.ptyProcesses()[0]!.exit(1)
      await waitFor(() => {
        const run = shell.host().harness!.history.get(launched.id)
        return run?.state === 'failed'
      })

      // A sidecar spawn failure refuses the launch typed and fabricates NO
      // run record: nothing observable ever existed.
      const live = await currentSession(channel, session.id)
      const before = shell.host().harness!.history.list().length
      shell.failNextSpawnWith('spawn_failed', 'the pty backend refused the harness')
      const failed = errorOf(
        await channel.execute(launchCommand(live, installationId, { attachTerminal: true }))
      )
      expect(failed.code).toBe('spawn_failed')
      expect(shell.host().harness!.history.list().length).toBe(before)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('an attachTerminal launch without a terminal runtime refuses capability_unavailable', async () => {
    const shell = await boot({ withSidecar: false })
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      await installManagedPi(channel)
      const installationId = shell.host().harness!.managedPi.status().installationId!
      expect(shell.host().terminal).toBeUndefined()
      const refused = errorOf(
        await channel.execute(launchCommand(session, installationId, { attachTerminal: true }))
      )
      expect(refused.code).toBe('capability_unavailable')
      // No run record, no PTY: the refusal preceded any fabrication.
      expect(shell.host().harness!.history.list()).toHaveLength(0)
      expect(shell.ptyProcesses()).toHaveLength(0)

      // The same launch without the intent still succeeds (PTY-backed flow).
      const launched = okValue(
        await channel.execute(
          launchCommand({ ...session, generation: session.generation }, installationId)
        )
      )
      expect(launched).toMatchObject({ state: 'starting' })
      expect((launched as { terminalId?: string }).terminalId).toBeUndefined()
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})

// ── register-level exit-observation discipline (injected clock + scripted
//    seams): the mapping rules that cannot be produced by the fake PTY ──────

type ExitNotice = { terminalId: string; generation: number; exitCode: number | null }

function registerRig(
  options: {
    spawnOk?: boolean
  } = {}
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-ptyspawn-rig-'))
  let nowMs = 1_000_000
  const clock = () => nowMs
  const sessions = new Map<string, RuntimeSession>()
  const session: RuntimeSession = {
    id: '00000000-0000-4000-8000-0000000000d1',
    scope: SCOPE_A,
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    worktreeId: WORKTREE_ID,
    lifecycle: 'ready',
    archived: false,
    projection: 'structured',
    generation: 1,
    version: 1,
  }
  sessions.set(session.id, session)
  const spawnSeamInputs: Array<{ runtimeSessionId: string; worktreeId: string; shell: string }> = []
  let exitObserver: ((notice: ExitNotice) => void) | undefined
  const managedPi: ManagedPiDriver = (() => {
    const status: ManagedPiStatus = {
      scope: SCOPE_A,
      driverId: 'managed-pi-test',
      driverVersion: '1',
      pinnedVersion: '1.0.0',
      state: 'ready',
      installationId: '00000000-0000-4000-8000-0000000000e1',
      resolvedVersion: '1.0.0',
      executableIdentity: '/opt/adea/managed-pi',
      executableLabel: 'managed-pi',
      observedAt: new Date(nowMs).toISOString(),
      generation: 1,
    }
    return {
      driverId: 'managed-pi-test',
      driverVersion: '1',
      pinnedVersion: '1.0.0',
      status: () => status,
      ensureInstalled: () => Promise.resolve(status),
    }
  })()
  const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {}
  const authority = {
    registerCommandProvider: (
      operation: DevOperation,
      provider: (command: DevCommand) => unknown
    ) => {
      providers[operation] = provider
    },
    registerStreamProvider: () => {},
  }
  const registration = registerHarnessRuntime({
    authority: authority as never,
    scope: SCOPE_A,
    dataDir,
    resolveSession: (id) => sessions.get(id),
    persistSession: (next) => sessions.set(next.id, next),
    managedPi,
    now: clock,
    spawnHarnessTerminal: (request) => {
      spawnSeamInputs.push(request)
      if (options.spawnOk === false) {
        return { ok: false as const, code: 'spawn_failed', message: 'scripted spawn failure' }
      }
      return { ok: true as const, terminalId: 'term-rig-1', terminalGeneration: 1 }
    },
    observeTerminalExit: (cb) => {
      exitObserver = cb
      return () => {
        exitObserver = undefined
      }
    },
  })
  async function launch(attachTerminal: boolean): Promise<Record<string, unknown>> {
    return providers['dev.session.launchHarness']!(
      commandFor(
        'dev.session.launchHarness',
        SCOPE_A,
        {
          runtimeSessionId: session.id,
          expectedGeneration: session.generation,
          harnessInstallationId: managedPi.status().installationId!,
          agentProfileId: 'profile-1',
          agentProfileVersion: 1,
          ...(attachTerminal ? { attachTerminal: true } : {}),
        },
        { resource: sessionResource(session) }
      )
    ) as Promise<Record<string, unknown>>
  }
  function drive(to: 'working'): void {
    const current = sessions.get(session.id) ?? session
    providers['dev.harness.runStatus']!(
      commandFor(
        'dev.harness.runStatus',
        SCOPE_A,
        {
          runtimeSessionId: session.id,
          expectedGeneration: current.generation,
          harnessRunId: (registration.history.list()[0] as { id: string }).id,
          state: to,
          source: 'host',
        },
        { resource: sessionResource(current) }
      )
    )
  }
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  return {
    registration,
    session,
    /** The CURRENT persisted session (launch bumps the generation). */
    currentSession: () => {
      const found = sessions.get(session.id)
      if (!found) throw new Error('rig session vanished')
      return found
    },
    spawnSeamInputs,
    emitExit: (notice: ExitNotice) => exitObserver?.(notice),
    call: (operation: DevOperation, body: Record<string, unknown>): unknown =>
      providers[operation]!(
        commandFor(operation, SCOPE_A, body, {
          resource: sessionResource(
            (() => {
              const found = sessions.get(session.id)
              if (!found) throw new Error('rig session vanished')
              return found
            })()
          ),
        })
      ),
    launch,
    drive,
    advanceTime: (ms: number) => {
      nowMs += ms
    },
    cleanup,
  }
}

describe('observed-exit mapping discipline (#400 residue)', () => {
  test('a signalled process maps to disconnected and never to an exit status', async () => {
    const rig = registerRig()
    try {
      const run = (await rig.launch(true)) as { id: string; terminalId: string }
      expect(run.terminalId).toBe('term-rig-1')
      expect(rig.spawnSeamInputs[0]).toMatchObject({
        runtimeSessionId: rig.session.id,
        worktreeId: WORKTREE_ID,
        shell: '/opt/adea/managed-pi',
      })
      rig.advanceTime(5_000)
      rig.drive('working')
      // exitCode null = the sidecar observed the process end by signal.
      rig.emitExit({ terminalId: 'term-rig-1', generation: 1, exitCode: null })
      const observed = rig.registration.history.get(run.id)!
      expect(observed.state).toBe('disconnected')
      expect(observed.finishedAt).toBe(new Date(1_005_000).toISOString())
      const exitEvent = rig.registration.events
        .read(rig.session.id)
        .find((event) => event.kind === 'run.disconnected')
      expect(exitEvent).toBeDefined()
      expect(exitEvent!.payload).toMatchObject({ exitCode: null })
    } finally {
      rig.cleanup()
    }
  })

  test('a zero exit from an illegal edge demotes to disconnected and preserves the code', async () => {
    const rig = registerRig()
    try {
      const run = (await rig.launch(true)) as { id: string }
      // The run is still `starting`: completed is an illegal edge from there.
      rig.emitExit({ terminalId: 'term-rig-1', generation: 1, exitCode: 0 })
      const observed = rig.registration.history.get(run.id)!
      expect(observed.state).toBe('disconnected')
      const exitEvent = rig.registration.events
        .read(rig.session.id)
        .find((event) => event.kind === 'run.disconnected')
      expect((exitEvent!.payload as { detail: string }).detail).toContain('demoted')
      expect((exitEvent!.payload as { exitCode: number }).exitCode).toBe(0)
    } finally {
      rig.cleanup()
    }
  })

  test('a notice naming another terminal never moves the run or consumes the subscription', async () => {
    const rig = registerRig()
    try {
      const run = (await rig.launch(true)) as { id: string }
      rig.drive('working')
      rig.emitExit({ terminalId: 'term-other', generation: 1, exitCode: 0 })
      expect(rig.registration.history.get(run.id)!.state).toBe('working')
      // The matching notice is the one that lands, exactly once.
      rig.emitExit({ terminalId: 'term-rig-1', generation: 1, exitCode: 0 })
      expect(rig.registration.history.get(run.id)!.state).toBe('completed')
      const exitEvents = rig.registration.events
        .read(rig.session.id)
        .filter((event) => event.sourceEventId.startsWith('host:run-exit:'))
      expect(exitEvents).toHaveLength(1)
    } finally {
      rig.cleanup()
    }
  })

  test('a bound-terminal notice at a foreign generation is consumed without applying', async () => {
    const rig = registerRig()
    try {
      const run = (await rig.launch(true)) as { id: string }
      rig.drive('working')
      // The bound terminal exits once; a notice that does not carry the
      // bound generation is not this run's process observation.
      rig.emitExit({ terminalId: 'term-rig-1', generation: 9, exitCode: 0 })
      expect(rig.registration.history.get(run.id)!.state).toBe('working')
      const exitEvents = rig.registration.events
        .read(rig.session.id)
        .filter((event) => event.sourceEventId.startsWith('host:run-exit:'))
      expect(exitEvents).toHaveLength(0)
    } finally {
      rig.cleanup()
    }
  })

  test('a cancelled run stays cancelled when the exit arrives and a failed spawn fabricates nothing', async () => {
    const rig = registerRig()
    try {
      const run = (await rig.launch(true)) as { id: string }
      const current = rig.currentSession()
      rig.call('dev.session.cancelHarness', {
        runtimeSessionId: rig.session.id,
        expectedGeneration: current.generation,
        harnessRunId: run.id,
      })
      expect(rig.registration.history.get(run.id)!.state).toBe('cancelled')
      rig.emitExit({ terminalId: 'term-rig-1', generation: 1, exitCode: 0 })
      expect(rig.registration.history.get(run.id)!.state).toBe('cancelled')
      const exitEvents = rig.registration.events
        .read(rig.session.id)
        .filter((event) => event.sourceEventId.startsWith('host:run-exit:'))
      expect(exitEvents).toHaveLength(0)

      // Spawn failure: the launch refuses typed and NO run record exists.
      const failing = registerRig({ spawnOk: false })
      try {
        await expect(failing.launch(true)).rejects.toMatchObject({ code: 'spawn_failed' })
        expect(failing.registration.history.list()).toHaveLength(0)
        expect(failing.spawnSeamInputs).toHaveLength(1)
      } finally {
        failing.cleanup()
      }
    } finally {
      rig.cleanup()
    }
  })
})
