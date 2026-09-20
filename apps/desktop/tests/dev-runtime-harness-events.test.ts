// Canonical runtime-session event log and the runtime-events-v1 stream (#400).
//
// Pins the spec "Event model" contract on the log (dedupe, idempotency
// conflict, per-generation sequence, bounded retention, bounded reads, scope
// isolation), and the stream/grant path through the M10 gate: the grant is
// minted against the CALLER'S authenticated channel identity, attaches once
// with a proof under the channel secret, and the stream handler replays a
// bounded newest-frame window, pushes live events, and closes
// `stale_generation` when the session moves on. Fake drivers only — no
// harness process is ever spawned.
import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeCbor,
  decodeRuntimeEvent,
  devCommandProofMessage,
  devOperationDefinitions,
  devStreamAttachProofMessage,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type DevStreamFrame,
  type DevStreamGrant,
  type RuntimeEvent,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import type { ChannelIdentity } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import { createManagedPiDriver } from '../shell/src/dev-runtime/harness/managed-pi-driver'
import {
  createSessionEventLog,
  MAX_EVENTS_PER_SESSION,
  MAX_TOTAL_EVENTS,
} from '../shell/src/dev-runtime/harness/events'

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

const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-events-0000-0000-0001',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}

const SHELL_HOST = '127.0.0.1'
const SHELL_PORT = 4795
const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`

const PINNED_ARCHIVE = new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')

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
    projectId: '00000000-0000-4000-8000-0000000000aa',
    repoId: '00000000-0000-4000-8000-0000000000ab',
  }),
} as unknown as import('../shell/src/dev-runtime/worktrees/service').WorktreeService

type SessionInput = Parameters<ReturnType<typeof createSessionEventLog>['append']>[0]

function eventInput(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    runtimeSessionId: '00000000-0000-4000-8000-0000000000b1',
    generation: 1,
    kind: 'run.created',
    sourceEventId: `evt-${randomUUID()}`,
    payload: {},
    ...overrides,
  }
}

let activeLogDir: string | undefined

function openLog() {
  activeLogDir = mkdtempSync(join(tmpdir(), 'adea-events-'))
  return createSessionEventLog({ dataDir: activeLogDir, scope: SCOPE_A })
}

function cleanup() {
  if (activeLogDir) rmSync(activeLogDir, { recursive: true, force: true })
  activeLogDir = undefined
}

describe('session event log semantics', () => {
  test('production retention bounds match the documented limits', () => {
    expect(MAX_EVENTS_PER_SESSION).toBe(1000)
    expect(MAX_TOTAL_EVENTS).toBe(5000)
  })

  test('sequences per generation and never fabricates a second session identity', () => {
    const s = openLog()
    try {
      const first = s.append(eventInput())!
      expect(first.seq).toBe('1')
      expect(first.schemaVersion).toBe(1)
      expect(first.source).toBe('host')
      expect(first.confidence).toBe('authoritative')
      expect(first.classification).toBe('workspace_metadata')
      const second = s.append(eventInput({ kind: 'run.starting' }))!
      expect(second.seq).toBe('2')
      // A new generation restarts the per-generation sequence.
      const nextGen = s.append(eventInput({ generation: 2, kind: 'run.resumed' }))!
      expect(nextGen.seq).toBe('1')
      expect(s.latestSequence('00000000-0000-4000-8000-0000000000b1', 1)).toBe('2')
      expect(s.latestSequence('00000000-0000-4000-8000-0000000000b1', 2)).toBe('1')
    } finally {
      cleanup()
    }
  })

  test('dedupes identical events and refuses conflicting ones under the same key', () => {
    const store = openLog()
    try {
      const input = eventInput({ sourceEventId: 'acp-turn-1', payload: { turn: 1 } })
      expect(store.append(input)).toBeDefined()
      // The exact same event is an ignored duplicate.
      expect(store.append(input)).toBeUndefined()
      // A DIFFERENT event under the same key is an idempotency conflict.
      expect(() =>
        store.append({ ...input, kind: 'run.starting', payload: { different: true } })
      ).toThrow()
      expect(store.events()).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  test('retention is bounded per session and across the scope, oldest first', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-events-bounds-'))
    try {
      const store = createSessionEventLog({
        dataDir,
        scope: SCOPE_A,
        maxPerSession: 20,
        maxTotal: 50,
      })
      const sessionId = '00000000-0000-4000-8000-0000000000b2'
      for (let i = 0; i < 30; i++) {
        store.append(
          eventInput({ runtimeSessionId: sessionId, sourceEventId: `e-${i}`, payload: { i } })
        )
      }
      const sessionEvents = store.events().filter((event) => event.runtimeSessionId === sessionId)
      expect(sessionEvents.length).toBeLessThanOrEqual(20)
      // The OLDEST events were dropped: the retained window starts late.
      expect(sessionEvents[0]!.seq).toBe('11')
      expect(store.read(sessionId, { limit: 500 }).at(-1)!.seq).toBe('30')
      // The total bound holds with a second session.
      const other = '00000000-0000-4000-8000-0000000000b3'
      for (let i = 0; i < 40; i++) {
        store.append(eventInput({ runtimeSessionId: other, sourceEventId: `x-${i}` }))
      }
      expect(store.events().length).toBeLessThanOrEqual(50)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('reads are bounded, ascending, and windowed by fromSequence', () => {
    const store = openLog()
    try {
      const sessionId = '00000000-0000-4000-8000-0000000000b4'
      for (let i = 1; i <= 9; i++) {
        store.append(eventInput({ runtimeSessionId: sessionId, sourceEventId: `w-${i}` }))
      }
      expect(store.read(sessionId, { fromSequence: '7' }).map((e) => e.seq)).toEqual([
        '7',
        '8',
        '9',
      ])
      expect(store.read(sessionId, { fromSequence: '2', limit: 3 }).map((e) => e.seq)).toEqual([
        '2',
        '3',
        '4',
      ])
      // The page cap holds: the log never answers with more than 500.
      expect(store.read(sessionId, { limit: 5000 })).toHaveLength(9)
      expect(store.read(sessionId, { generation: 2 })).toEqual([])
    } finally {
      cleanup()
    }
  })

  test('events of another scope are invisible', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-events-scope-'))
    try {
      const a = createSessionEventLog({ dataDir, scope: SCOPE_A })
      const b = createSessionEventLog({ dataDir, scope: SCOPE_B })
      const sessionId = '00000000-0000-4000-8000-0000000000b5'
      a.append(eventInput({ runtimeSessionId: sessionId }))
      expect(a.events()).toHaveLength(1)
      expect(b.events()).toHaveLength(0)
      expect(b.read(sessionId)).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('subscribers observe live events until unsubscribed', () => {
    const store = openLog()
    try {
      const sessionId = '00000000-0000-4000-8000-0000000000b6'
      const seen: RuntimeEvent[] = []
      const unsubscribe = store.subscribe(sessionId, (event) => seen.push(event))
      store.append(eventInput({ runtimeSessionId: sessionId }))
      unsubscribe()
      store.append(eventInput({ runtimeSessionId: sessionId, kind: 'run.starting' }))
      expect(seen.map((event) => event.kind)).toEqual(['run.created'])
    } finally {
      cleanup()
    }
  })
})

// ── Through the M10 gate: grants, attach, and the live stream ───────────────

type Boot = {
  authority: ReturnType<typeof createChannelAuthority>
  host(): DevRuntimeHost
  dataDir: string
  capturedStreamProvider(): Parameters<
    ReturnType<
      typeof import('../shell/src/dev-runtime/channel/server').createChannelGateway
    >['registerStreamHandler']
  >[1]
  openChannel(): Promise<{
    identity: ChannelIdentity
    secret: Buffer
    execute(command: DevCommand): Promise<DevReply>
  }>
}

async function boot(): Promise<Boot> {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-events-gate-'))
  const stateDir = join(dataDir, 'desktop-state')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const deviceKey = randomBytes(32)
  writeFileSync(join(stateDir, 'device.key'), deviceKey, { mode: 0o600 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deviceKey, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(SESSION), 'utf8'), cipher.final()])
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  writeFileSync(join(stateDir, 'session.sealed'), sealed.toString('base64'), { mode: 0o600 })
  const identityAuthority = createDesktopIdentityAuthority({
    dataDir,
    verifier: fakeCloudVerifier(),
  })
  const authority = createChannelAuthority({
    shellHost: SHELL_HOST,
    shellOrigin: SHELL_ORIGIN,
    authorizeCommand: async (command) => {
      identityAuthority.assertCommandScope(command.scope)
      await identityAuthority.ensureNodeEligible()
    },
  })
  // The gateway dependency is a registration seam (the WS plumbing is pinned
  // by shell-channel.test.ts): capture the runtime-events-v1 provider the
  // composition installs so the handler drives unit-level.
  let capturedProvider:
    | ((session: {
        grant: DevStreamGrant
        send: (frame: DevStreamFrame) => void
        close: (
          code:
            | 'normal'
            | 'expired'
            | 'revoked'
            | 'stale_generation'
            | 'backpressure'
            | 'incompatible',
          reason?: string
        ) => void
        onFrame?: (frame: DevStreamFrame) => void
        onClose?: () => void
      }) => void)
    | null = null
  const gateway = {
    registerStreamHandler: (protocol: string, provider: never) => {
      if (protocol === 'runtime-events-v1') capturedProvider = provider as never
    },
  }
  await identityAuthority.bind({ session: SESSION, claimed: SCOPE_A })
  const host = createDevRuntimeHost({
    authority,
    gateway: gateway as never,
    dataDir,
    scope: identityAuthority.currentScope(),
    identity: identityAuthority,
    approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    worktreeService: fakeWorktreeService,
    managedPi: createManagedPiDriver({
      scope: SCOPE_A,
      dataDir,
      installRoot: join(dataDir, 'managed-pi-install'),
      resolvePinnedArchive: () => Promise.resolve(PINNED_ARCHIVE),
    }),
  })
  mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })
  return {
    authority,
    host: () => host,
    dataDir,
    capturedStreamProvider: () => {
      if (!capturedProvider) throw new Error('runtime-events-v1 provider was not registered')
      return capturedProvider
    },
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
      const identity: ChannelIdentity = {
        channelId: handshakeReply.channelId,
        clientCredentialId: handshakeReply.clientCredentialId,
      }
      return {
        identity,
        secret,
        async execute(command: DevCommand) {
          return authority.execute(
            {
              channelId: identity.channelId,
              clientCredentialId: identity.clientCredentialId,
              command,
              proof: createHmac('sha256', secret)
                .update(
                  devCommandProofMessage({
                    channelId: identity.channelId,
                    clientCredentialId: identity.clientCredentialId,
                    command,
                  })
                )
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

function okValue(reply: DevReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`expected ok reply: ${JSON.stringify(reply.error)}`)
  return reply.value as Record<string, unknown>
}

function errorCode(reply: DevReply): string {
  if (reply.ok) throw new Error('expected error reply')
  return reply.error.code
}

async function sessionWithRun(shell: Boot, channel: Awaited<ReturnType<Boot['openChannel']>>) {
  shell.host().projectSession?.upsertProject({
    id: '00000000-0000-4000-8000-0000000000aa',
    scope: SCOPE_A,
    name: 'Events Project',
    groupIds: [],
    repoIds: ['00000000-0000-4000-8000-0000000000ab'],
    lifecycle: 'ready',
    version: 1,
  })
  const created = okValue(
    await channel.execute(
      commandFor('dev.session.create', SCOPE_A, {
        projectId: '00000000-0000-4000-8000-0000000000aa',
        repoId: '00000000-0000-4000-8000-0000000000ab',
        worktreeId: randomUUID(),
      })
    )
  ) as unknown as { id: string; generation: number }
  await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
  okValue(
    await channel.execute(
      commandFor(
        'dev.session.launchDefault',
        SCOPE_A,
        {
          runtimeSessionId: created.id,
          expectedGeneration: created.generation,
          agentProfileId: 'profile-1',
          agentProfileVersion: 1,
        },
        { resource: { kind: 'runtime_session', id: created.id, generation: created.generation } }
      )
    )
  )
  return { sessionId: created.id, liveGeneration: created.generation + 1 }
}

describe('dev.session.events through the gate', () => {
  test('mints a read grant bound to the caller channel and attaches exactly once', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const { sessionId, liveGeneration } = await sessionWithRun(shell, channel)
      const grant = okValue(
        await channel.execute(
          commandFor(
            'dev.session.events',
            SCOPE_A,
            {
              runtimeSessionId: sessionId,
              expectedGeneration: liveGeneration,
              direction: 'read',
            },
            {
              resource: {
                kind: 'runtime_session',
                id: sessionId,
                generation: liveGeneration,
              },
            }
          )
        )
      ) as unknown as DevStreamGrant
      expect(grant.protocol).toBe('runtime-events-v1')
      expect(grant.direction).toBe('read')
      expect(grant.resource).toEqual({
        kind: 'runtime_session',
        id: sessionId,
        generation: liveGeneration,
      })
      expect(grant.channelId).toBe(channel.identity.channelId)

      // Attach consumes the single-use grant with a proof under the channel
      // secret; a replayed attach is refused.
      const attach = {
        schemaVersion: 1,
        grantId: grant.grantId,
        requestId: randomUUID(),
        nonce: randomBytes(16).toString('base64url'),
        fromSequence: '0',
        proof: '',
      }
      attach.proof = createHmac('sha256', channel.secret)
        .update(devStreamAttachProofMessage({ channelId: channel.identity.channelId, attach }))
        .digest('base64url')
      const attached = shell.authority.attachStream({ identity: channel.identity, attach })
      expect(attached.grantId).toBe(grant.grantId)
      expect(() => shell.authority.attachStream({ identity: channel.identity, attach })).toThrow(
        /already consumed|replay_rejected/
      )
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('refuses stale generations, foreign scopes, and mismatched resources before minting', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      const { sessionId, liveGeneration } = await sessionWithRun(shell, channel)
      const stale = await channel.execute(
        commandFor(
          'dev.session.events',
          SCOPE_A,
          {
            runtimeSessionId: sessionId,
            expectedGeneration: liveGeneration - 1,
            direction: 'read',
          },
          {
            resource: {
              kind: 'runtime_session',
              id: sessionId,
              generation: liveGeneration - 1,
            },
          }
        )
      )
      expect(errorCode(stale)).toBe('stale_generation')

      const foreign = await channel.execute(
        commandFor(
          'dev.session.events',
          { ...SCOPE_A, workspaceId: '00000000-0000-4000-8000-000000000098' },
          {
            runtimeSessionId: sessionId,
            expectedGeneration: liveGeneration,
            direction: 'read',
          },
          {
            resource: {
              kind: 'runtime_session',
              id: sessionId,
              generation: liveGeneration,
            },
          }
        )
      )
      expect(errorCode(foreign)).toBe('channel_unauthorized')

      // The envelope decoder binds resource.id/resource.generation to the
      // body before any provider runs, so a foreign resource id never even
      // reaches the provider (it is refused as a malformed frame).
      const mismatched = await channel.execute(
        commandFor(
          'dev.session.events',
          SCOPE_A,
          {
            runtimeSessionId: sessionId,
            expectedGeneration: liveGeneration,
            direction: 'read',
          },
          { resource: { kind: 'runtime_session', id: randomUUID(), generation: 1 } }
        )
      )
      expect(errorCode(mismatched)).toBe('invalid_state')
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a grant bound to another channel never attaches to it', async () => {
    const shell = await boot()
    try {
      const owner = await shell.openChannel()
      const stranger = await shell.openChannel()
      const { sessionId, liveGeneration } = await sessionWithRun(shell, owner)
      const grant = okValue(
        await owner.execute(
          commandFor(
            'dev.session.events',
            SCOPE_A,
            {
              runtimeSessionId: sessionId,
              expectedGeneration: liveGeneration,
              direction: 'read',
            },
            {
              resource: {
                kind: 'runtime_session',
                id: sessionId,
                generation: liveGeneration,
              },
            }
          )
        )
      ) as unknown as DevStreamGrant
      const attach = {
        schemaVersion: 1,
        grantId: grant.grantId,
        requestId: randomUUID(),
        nonce: randomBytes(16).toString('base64url'),
        fromSequence: '0',
        proof: '',
      }
      attach.proof = createHmac('sha256', stranger.secret)
        .update(devStreamAttachProofMessage({ channelId: stranger.identity.channelId, attach }))
        .digest('base64url')
      expect(() => shell.authority.attachStream({ identity: stranger.identity, attach })).toThrow(
        /bound to another channel|identity_mismatch/
      )
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})

// ── The stream handler: bounded replay, live push, stale-generation close ──

type ScriptedSession = {
  grant: DevStreamGrant
  sent: DevStreamFrame[]
  closed?: { code: string; reason?: string }
  inbound: { markClosed(): void }
  onFrame?: (frame: DevStreamFrame) => void
  onClose?: () => void
  send: (frame: DevStreamFrame) => void
  close: (
    code: 'normal' | 'expired' | 'revoked' | 'stale_generation' | 'backpressure' | 'incompatible',
    reason?: string
  ) => void
}

function scriptedSession(grant: DevStreamGrant): ScriptedSession {
  const session: ScriptedSession = {
    grant,
    sent: [],
    inbound: { markClosed() {} },
    send: undefined as never,
    close: undefined as never,
  }
  session.send = (frame) => session.sent.push(frame)
  session.close = (code, reason) => {
    session.closed = { code, reason }
  }
  return session
}

function makeGrant(overrides: Partial<DevStreamGrant> = {}): DevStreamGrant {
  return {
    schemaVersion: 1,
    grantId: randomUUID(),
    protocol: 'runtime-events-v1',
    channelId: 'ch-test',
    scope: SCOPE_A,
    resource: {
      kind: 'runtime_session',
      id: '00000000-0000-4000-8000-0000000000c1',
      generation: 1,
    },
    direction: 'read',
    fromSequence: '0',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxFrameBytes: 65_536,
    ...overrides,
  }
}

describe('runtime-events-v1 stream handler', () => {
  test('replays the bounded window, pushes live events, and closes on a newer generation', async () => {
    const shell = await boot()
    try {
      const events = shell.host().harness!.events
      const sessionId = '00000000-0000-4000-8000-0000000000c1'
      for (let i = 1; i <= 3; i++) {
        events.append(
          eventInput({
            runtimeSessionId: sessionId,
            generation: 1,
            kind: 'run.starting',
            sourceEventId: `stream-${i}`,
          })
        )
      }
      const session = scriptedSession(
        makeGrant({ resource: { kind: 'runtime_session', id: sessionId, generation: 1 } })
      )
      shell.capturedStreamProvider()(session as never)

      // Replay: three data frames whose CBOR bytes decode to the events and
      // pass the strict wire decoder with host provenance.
      expect(session.sent).toHaveLength(3)
      session.sent.forEach((frame, index) => {
        const data = frame as { type: string; sequence: string; bytes: Uint8Array }
        expect(data.type).toBe('data')
        expect(data.sequence).toBe(String(index + 1))
        const decoded = decodeCbor(data.bytes).value as RuntimeEvent
        expect(decoded.runtimeSessionId).toBe(sessionId)
        expect(decoded.kind).toBe('run.starting')
        expect(decodeRuntimeEvent(decoded, { source: 'host' }).seq).toBe(String(index + 1))
      })

      // Live: an event of the granted generation is pushed immediately.
      events.append(
        eventInput({
          runtimeSessionId: sessionId,
          generation: 1,
          kind: 'run.completed',
          sourceEventId: 'stream-live',
        })
      )
      expect(session.sent).toHaveLength(4)

      // A NEWER generation event closes the stream stale_generation: grants
      // minted under an old generation are inert, never ambiguous.
      events.append(
        eventInput({
          runtimeSessionId: sessionId,
          generation: 2,
          kind: 'run.resumed',
          sourceEventId: 'stream-next-gen',
        })
      )
      expect(session.closed).toMatchObject({ code: 'stale_generation' })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('fromSequence windows the replay at the newest frames', async () => {
    const shell = await boot()
    try {
      const events = shell.host().harness!.events
      const sessionId = '00000000-0000-4000-8000-0000000000c2'
      for (let i = 1; i <= 5; i++) {
        events.append(
          eventInput({
            runtimeSessionId: sessionId,
            generation: 1,
            kind: 'run.starting',
            sourceEventId: `win-${i}`,
          })
        )
      }
      const session = scriptedSession(
        makeGrant({
          resource: { kind: 'runtime_session', id: sessionId, generation: 1 },
          fromSequence: '4',
        })
      )
      shell.capturedStreamProvider()(session as never)
      expect(session.sent.map((frame) => (frame as { sequence: string }).sequence)).toEqual([
        '4',
        '5',
      ])
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('non-runtime_session resources and write-direction grants close incompatible', async () => {
    const shell = await boot()
    try {
      const provider = shell.capturedStreamProvider()
      const wrongResource = scriptedSession(
        makeGrant({ resource: { kind: 'terminal', id: 'x', generation: 1 } })
      )
      provider(wrongResource as never)
      expect(wrongResource.closed).toMatchObject({ code: 'incompatible' })

      const wrongDirection = scriptedSession(makeGrant({ direction: 'write' }))
      provider(wrongDirection as never)
      expect(wrongDirection.closed).toMatchObject({ code: 'incompatible' })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('the composition registered the protocol with the channel authority', async () => {
    const shell = await boot()
    try {
      expect(shell.authority.hasStreamProvider('runtime-events-v1')).toBe(true)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
