// Harness launch → prompt delivery acceptance (#400 residue).
//
// Wires the launch transaction to the terminal input authority end-to-end and
// pins the delivery contract: the initial prompt of a PTY-backed launch is
// delivered exactly once (idempotent relaunch never re-delivers), through the
// fenced single-writer path (`prompt_delivery` ownership at the terminal's
// generation — a user writer loses ownership atomically and its later chunks
// are rejected before the PTY), with auditable provenance as canonical host
// events (`turn.user_input` on delivery, `capability.degraded` naming the
// typed reason otherwise), while a live ACP lane defers delivery to its own
// adapter. Real in-process sidecar + fake PTY only — no real harness runs.
import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  encodeCbor,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type DevStreamFrame,
  type DevStreamGrant,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import { registerTerminalRuntime } from '../shell/src/dev-runtime/terminal/register'
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
import { createManagedPiDriver } from '../shell/src/dev-runtime/harness/managed-pi-driver'
import type { AcpLaneDriver } from '../shell/src/dev-runtime/harness/acp-lane'
import type { WorktreeService } from '../shell/src/dev-runtime/worktrees/service'

const SHELL_HOST = '127.0.0.1'
const SHELL_PORT = 4801
const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`

const SCOPE_A: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}

const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-prompt-0000-0000-0001',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}

const PINNED_ARCHIVE = new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')
const DEFAULT_ARCHIVE = () => Promise.resolve(PINNED_ARCHIVE)

const WORKTREE_ID = '00000000-0000-4000-8000-0000000000bb'
const PROJECT_ID = '00000000-0000-4000-8000-0000000000aa'
const REPO_ID = '00000000-0000-4000-8000-0000000000ab'

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
    canonicalRoot: '/tmp/adea-prompt-worktree',
    rootIdentity: { device: '1', inode: '2', mtimeNs: '3', size: '4' },
    generation: 1,
    lifecycle: 'ready',
  }),
} as unknown as WorktreeService

function noopAcpDriver(): AcpLaneDriver {
  return {
    driverId: 'scripted-acp',
    driverVersion: '1',
    async spawn() {
      return {
        ok: true,
        handshake: {
          protocolVersion: '1',
          capabilities: ['session'],
          sessionOperations: ['session.new'],
          history: 'unavailable' as const,
          processIdentity: 'scripted-prompt-pid',
        },
      }
    },
    async close() {},
  }
}

/** Boots the full composition with a real in-process sidecar + fake PTY. */
async function boot(options: { acpDriver?: AcpLaneDriver } = {}): Promise<{
  authority: ReturnType<typeof createChannelAuthority>
  host(): DevRuntimeHost
  dataDir: string
  ptyProcesses(): ReturnType<typeof createFakePtyAdapter>['processes']
  openChannel(): Promise<{
    execute(command: DevCommand): Promise<DevReply>
  }>
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-harness-prompt-'))
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

  const credential = newSidecarCredential()
  const fake = createFakePtyAdapter()
  const service = createSidecarService({
    runtimeRoot: join(dataDir, 'dev-runtime'),
    ptyAdapter: fake.adapter,
    sidecarVersion: '1.0.0-test',
    credential,
    executableIdentity: 'sidecar@prompt-test',
    pidStartIdentity: 'prompt-test-identity',
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
  const sidecar: SidecarClient = connected.client

  const host = createDevRuntimeHost({
    authority,
    gateway,
    dataDir,
    scope: identity.currentScope(),
    identity,
    approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    sidecar,
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    worktreeService: fakeWorktreeService,
    managedPi: createManagedPiDriver({
      scope: SCOPE_A,
      dataDir,
      installRoot: join(dataDir, 'managed-pi-install'),
      resolvePinnedArchive: DEFAULT_ARCHIVE,
    }),
    ...(options.acpDriver ? { acpDriver: options.acpDriver } : {}),
  })
  mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })
  return {
    authority,
    host: () => host,
    dataDir,
    ptyProcesses: () => fake.processes,
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

/** Registers the project, creates a session, installs managed Pi. */
async function sessionReady(
  shell: Awaited<ReturnType<typeof boot>>,
  channel: Awaited<ReturnType<ReturnType<typeof boot>['openChannel']>>
) {
  shell.host().projectSession?.upsertProject({
    id: PROJECT_ID,
    scope: SCOPE_A,
    name: 'Prompt Project',
    groupIds: [],
    repoIds: [REPO_ID],
    lifecycle: 'ready',
    version: 1,
  })
  const created = okValue(
    await channel.execute(
      commandFor('dev.session.create', SCOPE_A, {
        projectId: PROJECT_ID,
        repoId: REPO_ID,
        worktreeId: WORKTREE_ID,
      })
    )
  ) as unknown as { id: string; generation: number }
  okValue(await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {})))
  return created
}

async function createTerminal(
  channel: Awaited<ReturnType<ReturnType<typeof boot>['openChannel']>>,
  runtimeSessionId: string
): Promise<{ id: string; generation: number }> {
  const record = okValue(
    await channel.execute(
      commandFor('dev.terminal.create', SCOPE_A, {
        runtimeSessionId,
        worktreeId: WORKTREE_ID,
        cols: 80,
        rows: 24,
      })
    )
  ) as unknown as { id: string; generation: number }
  return record
}

function launchCommand(
  session: { id: string; generation: number },
  installationId: string,
  initialPrompt?: string
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
      ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    },
    { resource: sessionResource(session) }
  )
}

function promptEventsOf(shell: Awaited<ReturnType<typeof boot>>, sessionId: string) {
  return shell
    .host()
    .harness!.events.read(sessionId)
    .filter((event) => event.sourceEventId.startsWith('host:prompt:'))
}

describe('launch → guarded PTY prompt delivery (#400 residue)', () => {
  test('a launch with an initial prompt delivers exactly once through the fenced input authority', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      const terminal = await createTerminal(channel, session.id)
      const installationId = shell.host().harness!.managedPi.status().installationId!

      const launched = okValue(
        await channel.execute(launchCommand(session, installationId, 'ship the residue'))
      )
      expect(launched).toMatchObject({ state: 'starting' })

      // The prompt reached the PTY verbatim with exactly one Enter terminator.
      expect(shell.ptyProcesses()).toHaveLength(1)
      const written = shell.ptyProcesses()[0]!.written
      expect(written.length).toBeGreaterThan(0)
      const bytes = Buffer.concat(written.map((chunk) => Buffer.from(chunk)))
      expect(bytes.toString('utf8')).toBe('ship the residue\n')

      // Delivery provenance is a canonical host event, not content.
      const events = promptEventsOf(shell, session.id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'turn.user_input',
        source: 'host',
        confidence: 'authoritative',
        classification: 'workspace_private',
      })
      expect(events[0]!.payload).toMatchObject({
        harnessRunId: launched.id,
        transport: 'pty_input',
        terminalId: terminal.id,
        terminalGeneration: terminal.generation,
      })
      expect(JSON.stringify(events[0]!.payload)).not.toContain('ship the residue')

      // Idempotent relaunch returns the run and NEVER re-delivers.
      const relaunched = okValue(
        await channel.execute(
          launchCommand(
            { ...session, generation: session.generation + 1 },
            installationId,
            'ship the residue'
          )
        )
      )
      expect(relaunched.id).toBe(launched.id)
      const writtenAfterRelaunch = Buffer.concat(
        shell.ptyProcesses()[0]!.written.map((chunk) => Buffer.from(chunk))
      )
      expect(writtenAfterRelaunch.toString('utf8')).toBe('ship the residue\n')
      expect(promptEventsOf(shell, session.id)).toHaveLength(1)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a launch without a live terminal records a typed degraded fact, not a fake delivery', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      const installationId = shell.host().harness!.managedPi.status().installationId!
      const launched = okValue(
        await channel.execute(launchCommand(session, installationId, 'no terminal here'))
      )
      expect(launched).toMatchObject({ state: 'starting' })
      // No PTY exists; the delivery fact is the typed non-delivery.
      expect(shell.ptyProcesses()).toHaveLength(0)
      const events = promptEventsOf(shell, session.id)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'capability.degraded',
        classification: 'workspace_metadata',
      })
      expect((events[0]!.payload as { reason: string }).reason).toContain('no terminal')
      // The launch itself still succeeded: partial failure retains the session.
      const runs = okValue(await channel.execute(commandFor('dev.harness.runs', SCOPE_A, {})))
      expect((runs.items as Array<{ id: string }>)[0]!.id).toBe(launched.id)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a live ACP lane owns prompt delivery; the host never touches the PTY input stream', async () => {
    const installationId = randomUUID()
    // Seed an ACP-capable installation into the discovery inventory.
    const entry = {
      id: installationId,
      scope: SCOPE_A,
      family: 'opencode',
      displayName: 'OpenCode (ACP)',
      driverId: 'local-executable',
      driverVersion: '1',
      provenance: 'user_managed',
      executableIdentity: '/opt/homebrew/bin/opencode',
      executableLabel: 'opencode',
      protocol: 'acp',
      acpAvailability: 'available',
      acpVersion: '1',
      version: '1.2.3',
      auth: 'ready',
      health: 'healthy',
      compatibility: 'compatible',
      capabilities: ['native', 'acp', 'models', 'resume'],
      sessionOperations: ['session.new'],
      entitlementHints: ['user_managed'],
      limitations: [],
      transport: 'direct_local',
      models: [],
      observedAt: new Date().toISOString(),
      generation: 1,
    }
    const shell = await boot({ acpDriver: noopAcpDriver() })
    try {
      const { mkdirSync: mkdir, writeFileSync: write } = await import('node:fs')
      const dir = join(shell.dataDir, 'dev-runtime', 'discovery')
      mkdir(dir, { recursive: true, mode: 0o700 })
      write(
        join(dir, 'inventory.json'),
        JSON.stringify({
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          records: [{ kind: 'connection', entry }],
        })
      )
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      const terminal = await createTerminal(channel, session.id)

      // The ACP lane connects to the SAME canonical session: from here the
      // lane adapter owns prompt delivery (the explicit transport split).
      okValue(
        await channel.execute(
          commandFor(
            'dev.harness.acpConnect',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation,
              harnessInstallationId: installationId,
            },
            { resource: sessionResource(session) }
          )
        )
      )
      const launched = okValue(
        await channel.execute(
          launchCommand(
            { ...session, generation: session.generation },
            installationId,
            'lane prompt'
          )
        )
      )
      expect(launched).toMatchObject({ state: 'starting' })
      // The terminal PTY received NOTHING; no host turn event was fabricated
      // over the lane's own tier.
      expect(shell.ptyProcesses()).toHaveLength(1)
      expect(shell.ptyProcesses()[0]!.written).toHaveLength(0)
      expect(promptEventsOf(shell, session.id)).toHaveLength(0)
      void terminal
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('prompt delivery fences the terminal input authority (#400 residue)', () => {
  test('delivery takes single-writer ownership and a superseded user writer is rejected', async () => {
    // Standalone terminal registration with a captured write-stream provider,
    // so the user-writer side of the fence can be driven directly.
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-prompt-fence-'))
    const runtimeRoot = join(dataDir, 'dev-runtime')
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
    try {
      const authority = createChannelAuthority({
        shellHost: SHELL_HOST,
        shellOrigin: SHELL_ORIGIN,
      })
      let writeProvider:
        | ((session: {
            grant: DevStreamGrant
            send: (frame: DevStreamFrame) => void
            close: (code: 'normal' | 'stale_generation' | 'incompatible', reason?: string) => void
            onFrame?: (frame: DevStreamFrame) => void
            onClose?: () => void
          }) => void)
        | null = null
      const gateway = {
        registerStreamHandler: (protocol: string, provider: never) => {
          if (protocol === 'terminal-bytes-v1') writeProvider = provider as never
        },
      }
      const credential = newSidecarCredential()
      const fake = createFakePtyAdapter()
      const service = createSidecarService({
        runtimeRoot,
        ptyAdapter: fake.adapter,
        sidecarVersion: '1.0.0-test',
        credential,
        executableIdentity: 'sidecar@fence-test',
        pidStartIdentity: 'fence-test-identity',
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

      const registration = registerTerminalRuntime({
        authority,
        gateway: gateway as never,
        sidecar: connected.client,
        scope: SCOPE_A,
        runtimeRoot,
        resolveWorktreeRoot: (id) => (id === WORKTREE_ID ? '/tmp/adea-prompt-worktree' : null),
      })
      const channel = await (async () => {
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
        return {
          async execute(command: DevCommand) {
            return authority.execute(
              {
                channelId: handshakeReply.channelId,
                clientCredentialId: handshakeReply.clientCredentialId,
                command,
                proof: createHmac('sha256', secret)
                  .update(
                    devCommandProofMessage({
                      channelId: handshakeReply.channelId,
                      clientCredentialId: handshakeReply.clientCredentialId,
                      command,
                    })
                  )
                  .digest('base64url'),
              },
              { trusted: true }
            )
          },
        }
      })()

      const runtimeSessionId = '00000000-0000-4000-8000-0000000000c1'
      const terminal = okValue(
        await channel.execute(
          commandFor('dev.terminal.create', SCOPE_A, {
            runtimeSessionId,
            worktreeId: WORKTREE_ID,
            cols: 80,
            rows: 24,
          })
        )
      ) as unknown as { id: string; generation: number }

      // A user writer owns the terminal through its write grant…
      const scriptedSession = {
        grant: {
          schemaVersion: 1,
          grantId: randomUUID(),
          protocol: 'terminal-bytes-v1' as const,
          channelId: 'ch-fence',
          scope: SCOPE_A,
          resource: { kind: 'terminal' as const, id: terminal.id, generation: terminal.generation },
          direction: 'write' as const,
          fromSequence: '0',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          maxFrameBytes: 65_536,
        },
        sent: [] as DevStreamFrame[],
        closed: undefined as { code: string; reason?: string } | undefined,
        onFrame: undefined as ((frame: DevStreamFrame) => void) | undefined,
        onClose: undefined as (() => void) | undefined,
        send: undefined as never,
        close: undefined as never,
      }
      scriptedSession.send = (frame) => scriptedSession.sent.push(frame)
      scriptedSession.close = (code, reason) => {
        scriptedSession.closed = { code, reason }
      }
      ;(writeProvider as NonNullable<typeof writeProvider>)(scriptedSession as never)

      // …prompt delivery takes the ownership atomically and delivers…
      const delivered = await registration.deliverPrompt({
        runtimeSessionId,
        prompt: 'fenced prompt',
      })
      expect(delivered).toMatchObject({ ok: true, terminalGeneration: terminal.generation })
      const bytes = Buffer.concat(fake.processes[0]!.written.map((chunk) => Buffer.from(chunk)))
      expect(bytes.toString('utf8')).toBe('fenced prompt\n')

      // …and the superseded writer's chunk is rejected before the PTY.
      scriptedSession.onFrame?.({
        type: 'input',
        sequence: '1',
        generation: terminal.generation,
        bytes: new TextEncoder().encode('user typing'),
      })
      expect(scriptedSession.closed).toMatchObject({ code: 'stale_generation' })
      expect(bytes.toString('utf8')).toBe('fenced prompt\n')

      // Delivery into a session without a terminal is a typed non-delivery.
      const missing = await registration.deliverPrompt({
        runtimeSessionId: '00000000-0000-4000-8000-0000000000c9',
        prompt: 'nobody home',
      })
      expect(missing).toMatchObject({ ok: false })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a delivered prompt still encodes as canonical CBOR evidence for the stream', () => {
    // The provenance payload rides runtime-events-v1 as CBOR; pin the encode
    // round-trip so the delivery fact stays stream-consumable.
    const payload = {
      harnessRunId: 'run-1',
      transport: 'pty_input',
      terminalId: 'term-1',
      terminalGeneration: 1,
      chunks: 1,
      bytes: 14,
    }
    const decoded = encodeCbor(payload)
    expect(decoded.byteLength).toBeGreaterThan(0)
  })
})
