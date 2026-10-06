// Workspace memory → harness launch acceptance (ADR 0012, "Memory").
//
// Wires the shared memory store into the real Dev Runtime composition (real
// channel gate, in-process sidecar, fake PTY) and pins the launch contract:
// the session workspace's ACTIVE entries compile newest first into one
// bounded preamble that leads the initial prompt in ONE guarded delivery; the
// disabled switch, an empty store, and pending proposals inject nothing;
// another workspace's entries never reach the session; a bound overflow is a
// typed `memory_truncated` diagnostic on the run and its event stream; and
// `dev.memory.propose` lands session-scoped pending proposals, deny-by-default.
import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDecoders,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
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
import type { WorktreeService } from '../shell/src/dev-runtime/worktrees/service'
import { createMemoryStore, type MemoryStore } from '../shell/src/memory/store'
import { MEMORY_PREAMBLE_HEADER } from '../shell/src/memory/preamble'

const SHELL_HOST = '127.0.0.1'
const SHELL_PORT = 4802
const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`

const SCOPE_A: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const OTHER_WORKSPACE = '00000000-0000-4000-8000-0000000000ff'

const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-memory-0000-0000-0001',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}

const PINNED_ARCHIVE = new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')
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

const fakeWorktreeService = {
  getWorktree: (scope: Scope, worktreeId: string) => ({
    id: worktreeId,
    scope,
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    canonicalRoot: '/tmp/adea-memory-worktree',
    rootIdentity: { device: '1', inode: '2', mtimeNs: '3', size: '4' },
    generation: 1,
    lifecycle: 'ready',
  }),
} as unknown as WorktreeService

type Shell = Awaited<ReturnType<typeof boot>>
type Channel = Awaited<ReturnType<Shell['openChannel']>>

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-memory-launch-'))
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
    executableIdentity: 'sidecar@memory-test',
    pidStartIdentity: 'memory-test-identity',
    managerLimits: { ...TERMINAL_LIMITS, ringMaxBytes: 65_536, subscriberHighWaterBytes: 1024 },
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

  // Deterministic clock: each memory write is one second newer.
  let clock = Date.parse('2026-10-01T00:00:00.000Z')
  const memory = createMemoryStore({
    contentDir: join(dataDir, 'local-content'),
    key: () => deviceKey,
    now: () => (clock += 1000),
  })

  const host = createDevRuntimeHost({
    credentialStore: createInMemoryVaultKeyStore(),
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
      resolvePinnedArchive: () => Promise.resolve(PINNED_ARCHIVE),
    }),
    memory,
  })
  mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })
  return {
    host: (): DevRuntimeHost => host,
    memory: (): MemoryStore => memory,
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
    scope: SCOPE_A,
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

function errorOf(reply: DevReply) {
  if (reply.ok) throw new Error('expected a refusal')
  return reply.error
}

async function sessionReady(shell: Shell, channel: Channel) {
  shell.host().projectSession?.upsertProject({
    id: PROJECT_ID,
    scope: SCOPE_A,
    name: 'Memory Project',
    groupIds: [],
    repoIds: [REPO_ID],
    lifecycle: 'ready',
    version: 1,
  })
  const created = okValue(
    await channel.execute(
      commandFor('dev.session.create', {
        projectId: PROJECT_ID,
        repoId: REPO_ID,
        worktreeId: WORKTREE_ID,
      })
    )
  ) as unknown as { id: string; generation: number }
  okValue(await channel.execute(commandFor('dev.harness.managedPiInstall', {})))
  okValue(
    await channel.execute(
      commandFor('dev.terminal.create', {
        runtimeSessionId: created.id,
        worktreeId: WORKTREE_ID,
        cols: 80,
        rows: 24,
      })
    )
  )
  return created
}

async function launch(
  shell: Shell,
  channel: Channel,
  session: { id: string; generation: number },
  initialPrompt?: string
) {
  const installationId = shell.host().harness!.managedPi.status().installationId!
  return channel.execute(
    commandFor(
      'dev.session.launchHarness',
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
  )
}

function ptyText(shell: Shell): string {
  const processes = shell.ptyProcesses()
  if (processes.length === 0) return ''
  return Buffer.concat(processes[0]!.written.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

function hostEvents(shell: Shell, sessionId: string, prefix: string) {
  return shell
    .host()
    .harness!.events.read(sessionId)
    .filter((event) => event.sourceEventId.startsWith(prefix))
}

describe('workspace memory launch injection (ADR 0012)', () => {
  test('active entries lead the initial prompt newest first in one guarded delivery', async () => {
    const shell = await boot()
    try {
      const memory = shell.memory()
      memory.create(SCOPE_A.workspaceId, { text: 'oldest note' })
      memory.create(SCOPE_A.workspaceId, { text: 'middle note\nwith a second line' })
      memory.create(SCOPE_A.workspaceId, { text: 'newest note' })
      // Never injected: a pending proposal and another workspace's entry.
      memory.propose(SCOPE_A.workspaceId, { text: 'pending proposal text' })
      memory.create(OTHER_WORKSPACE, { text: 'foreign workspace note' })

      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      const run = okValue(await launch(shell, channel, session, 'ship the change'))
      expect(run.diagnostics).toBeUndefined()

      expect(ptyText(shell)).toBe(
        `${MEMORY_PREAMBLE_HEADER}\n- newest note\n- middle note\n  with a second line\n- oldest note\n\nship the change\n`
      )
      const delivered = hostEvents(shell, session.id, 'host:prompt:')
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({ kind: 'turn.user_input' })
      expect(delivered[0]!.payload).toMatchObject({
        harnessRunId: run.id,
        transport: 'pty_input',
        memoryEntries: 3,
      })
      const serialized = JSON.stringify(shell.host().harness!.events.read(session.id))
      expect(serialized).not.toContain('newest note')
      expect(serialized).not.toContain('foreign workspace note')
      expect(hostEvents(shell, session.id, 'host:memory:')).toHaveLength(0)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a preamble with no initial prompt is delivered on its own', async () => {
    const shell = await boot()
    try {
      shell.memory().create(SCOPE_A.workspaceId, { text: 'only memory' })
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      okValue(await launch(shell, channel, session))
      expect(ptyText(shell)).toBe(`${MEMORY_PREAMBLE_HEADER}\n- only memory\n`)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('the disabled switch and an empty store send nothing extra', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      // Empty store, no prompt: nothing at all reaches the PTY.
      const first = okValue(await launch(shell, channel, session))
      expect(ptyText(shell)).toBe('')
      expect(hostEvents(shell, session.id, 'host:prompt:')).toHaveLength(0)
      okValue(
        await channel.execute(
          commandFor(
            'dev.session.cancelHarness',
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation + 1,
              harnessRunId: first.id,
            },
            { resource: sessionResource({ id: session.id, generation: session.generation + 1 }) }
          )
        )
      )

      // Entries exist but injection is off: only the prompt is delivered.
      shell.memory().create(SCOPE_A.workspaceId, { text: 'kept but not injected' })
      shell.memory().setInjectionEnabled(SCOPE_A.workspaceId, false)
      okValue(
        await launch(
          shell,
          channel,
          { id: session.id, generation: session.generation + 2 },
          'prompt only'
        )
      )
      expect(ptyText(shell)).toBe('prompt only\n')
      expect(shell.memory().list(SCOPE_A.workspaceId).entries).toHaveLength(1)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('an overflow injects whole entries newest first and records memory_truncated', async () => {
    const shell = await boot()
    try {
      for (let index = 0; index < 10; index += 1) {
        shell.memory().create(SCOPE_A.workspaceId, { text: `${String(index)}`.padEnd(2_000, 'x') })
      }
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      const run = okValue(await launch(shell, channel, session, 'go'))
      const diagnostic = { code: 'memory_truncated', includedEntries: 8, omittedEntries: 2 }
      expect((run.diagnostics as unknown[])[0]).toMatchObject({
        ...diagnostic,
        limitBytes: 16 * 1024,
      })
      // The run decodes under the strict wire contract with its diagnostic.
      expect(() =>
        devOperationDecoders['dev.harness.runs'].reply({
          schemaVersion: 1,
          operation: 'dev.harness.runs',
          requestId: randomUUID(),
          ok: true,
          value: { items: [run], observedAt: new Date().toISOString() },
          observedAt: new Date().toISOString(),
        })
      ).not.toThrow()
      // History carries the diagnostic, and the stream carries the fact.
      const runs = okValue(await channel.execute(commandFor('dev.harness.runs', {})))
      expect((runs.items as Array<{ diagnostics?: unknown[] }>)[0]!.diagnostics).toHaveLength(1)
      const facts = hostEvents(shell, session.id, 'host:memory:')
      expect(facts).toHaveLength(1)
      expect(facts[0]).toMatchObject({ kind: 'capability.degraded' })
      expect(facts[0]!.payload).toMatchObject(diagnostic)

      const text = ptyText(shell)
      expect(new TextEncoder().encode(text).byteLength).toBeLessThan(16 * 1024 + 8)
      // Newest (9) first; the two oldest (0, 1) are the omitted ones.
      const order = [...text.matchAll(/^- (\d)x/gm)].map((match) => match[1])
      expect(order).toEqual(['9', '8', '7', '6', '5', '4', '3', '2'])
      expect(text.endsWith('\n\ngo\n')).toBe(true)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('dev.memory.propose (ADR 0012 agent proposals)', () => {
  function proposeCommand(
    session: { id: string; generation: number },
    text: string,
    overrides: Partial<DevCommand> = {}
  ) {
    return commandFor(
      'dev.memory.propose',
      { runtimeSessionId: session.id, expectedGeneration: session.generation, text },
      { resource: sessionResource(session), ...overrides }
    )
  }

  test('a live run proposes into its own workspace as pending, never active', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      // No active run yet: the proposal is refused before anything is stored.
      expect(errorOf(await channel.execute(proposeCommand(session, 'too early'))).code).toBe(
        'invalid_state'
      )
      okValue(await launch(shell, channel, session))
      const live = { id: session.id, generation: session.generation + 1 }
      const receipt = okValue(await channel.execute(proposeCommand(live, 'prefers bun')))
      expect(receipt).toMatchObject({ status: 'pending' })
      expect(JSON.stringify(receipt)).not.toContain('prefers bun')

      const snapshot = shell.memory().list(SCOPE_A.workspaceId)
      expect(snapshot.entries).toEqual([
        expect.objectContaining({
          id: receipt.memoryEntryId,
          text: 'prefers bun',
          source: 'agent',
          status: 'pending',
        }),
      ])
      expect(shell.memory().list(OTHER_WORKSPACE).entries).toHaveLength(0)
      // A pending proposal is not injected.
      expect(shell.memory().preamble(SCOPE_A.workspaceId)).toBeUndefined()
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('deny by default: missing capability, unbound resource, stale generation, oversize text', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      okValue(await launch(shell, channel, session))
      const live = { id: session.id, generation: session.generation + 1 }

      const noCapability = await channel.execute(
        proposeCommand(live, 'x', { capabilities: ['dev.harness.manage'] })
      )
      // The strict command decoder refuses a capability set that is not
      // exactly the registry's before any provider runs.
      expect(['capability_denied', 'invalid_state']).toContain(errorOf(noCapability).code)

      const unbound = await channel.execute(
        commandFor('dev.memory.propose', {
          runtimeSessionId: live.id,
          expectedGeneration: live.generation,
          text: 'x',
        })
      )
      expect(unbound.ok).toBe(false)

      const stale = await channel.execute(proposeCommand(session, 'x'))
      expect(errorOf(stale).code).toBe('stale_generation')

      const oversize = await channel.execute(proposeCommand(live, 'y'.repeat(2_001)))
      expect(oversize.ok).toBe(false)

      // The body names no workspace: an injected workspace field is refused.
      const injected = await channel.execute(
        commandFor(
          'dev.memory.propose',
          {
            runtimeSessionId: live.id,
            expectedGeneration: live.generation,
            text: 'x',
            workspaceId: OTHER_WORKSPACE,
          },
          { resource: sessionResource(live) }
        )
      )
      expect(injected.ok).toBe(false)
      expect(shell.memory().list(SCOPE_A.workspaceId).entries).toHaveLength(0)
      expect(shell.memory().list(OTHER_WORKSPACE).entries).toHaveLength(0)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('the pending bound refuses typed limit_exceeded', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const session = await sessionReady(shell, channel)
      okValue(await launch(shell, channel, session))
      const live = { id: session.id, generation: session.generation + 1 }
      for (let index = 0; index < 20; index += 1) {
        okValue(await channel.execute(proposeCommand(live, `proposal ${String(index)}`)))
      }
      expect(errorOf(await channel.execute(proposeCommand(live, 'one too many'))).code).toBe(
        'limit_exceeded'
      )
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
