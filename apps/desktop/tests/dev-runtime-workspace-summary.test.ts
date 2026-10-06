// Counts-only cross-workspace run summary (ADR 0011, `dev.summary.workspaces`).
//
// Boots the real composition graph (channel authority → identity authority →
// gateway → Dev Runtime host) and drives the operation through the M10 gate
// with signed frames:
// - counts per workspace come from the shared harness run registry for every
//   scope with the active scope's account AND runtime node; another account's
//   or node's runs are never counted;
// - terminal and `unknown` runs are excluded; resolving/starting/working are
//   `running`, awaiting_input/awaiting_approval are `needsInput`;
// - the active scope's archived or unresolvable sessions are excluded;
// - deny-by-default: wrong capabilities, extra body keys, a resource binding,
//   and a foreign scope are refused before any count is returned;
// - no other project/session authority partition is opened or created.
import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeWorkspaceRunSummary,
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type HarnessRunState,
  type RuntimeSession,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createInMemoryVaultKeyStore } from '../shell/src/dev-runtime/vault'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import { createRunHistoryStore } from '../shell/src/dev-runtime/harness/runs'
import { summarizeWorkspaceRuns } from '../shell/src/dev-runtime/harness/workspace-summary'
import type { WorktreeService } from '../shell/src/dev-runtime/worktrees/service'

const SHELL_HOST = '127.0.0.1'
const SHELL_PORT = 4787
const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`

const ACCOUNT = '00000000-0000-4000-8000-000000000001'
const NODE = '00000000-0000-4000-8000-000000000003'
/** The active scope. */
const SCOPE_A: Scope = {
  accountId: ACCOUNT,
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: NODE,
}
/** Same account and node, another workspace: counted. */
const SCOPE_B: Scope = { ...SCOPE_A, workspaceId: '00000000-0000-4000-8000-0000000000b2' }
/** Same account, different runtime node: excluded. */
const SCOPE_OTHER_NODE: Scope = {
  ...SCOPE_A,
  workspaceId: '00000000-0000-4000-8000-0000000000c3',
  runtimeNodeId: '00000000-0000-4000-8000-0000000000c9',
}
/** Different account, same node: excluded. */
const SCOPE_OTHER_ACCOUNT: Scope = {
  ...SCOPE_A,
  accountId: '00000000-0000-4000-8000-0000000000d9',
  workspaceId: '00000000-0000-4000-8000-0000000000d4',
}

const PROJECT_ID = '00000000-0000-4000-8000-0000000000aa'
const REPO_ID = '00000000-0000-4000-8000-0000000000ab'

const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-summary-0000-0000-0001',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}

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
  }),
} as unknown as WorktreeService

type Channel = { execute(command: DevCommand): Promise<DevReply> }

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-summary-'))
  const stateDir = join(dataDir, 'desktop-state')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const deviceKey = randomBytes(32)
  writeFileSync(join(stateDir, 'device.key'), deviceKey, { mode: 0o600 })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deviceKey, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(SESSION), 'utf8'), cipher.final()])
  writeFileSync(
    join(stateDir, 'session.sealed'),
    Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'),
    { mode: 0o600 }
  )
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
  const host: DevRuntimeHost = createDevRuntimeHost({
    authority,
    gateway,
    dataDir,
    scope: identity.currentScope(),
    identity,
    approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    credentialStore: createInMemoryVaultKeyStore(),
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    worktreeService: fakeWorktreeService,
  })

  function openChannel(): Channel {
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
    const { channelId, clientCredentialId } = handshakeReply
    return {
      execute: (command) =>
        authority.execute(
          {
            channelId,
            clientCredentialId,
            command,
            proof: createHmac('sha256', secret)
              .update(devCommandProofMessage({ channelId, clientCredentialId, command }))
              .digest('base64url'),
          },
          { trusted: true }
        ),
    }
  }

  return { dataDir, host, authority, channel: openChannel() }
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

function registerProject(host: DevRuntimeHost): void {
  host.projectSession?.upsertProject({
    id: PROJECT_ID,
    scope: SCOPE_A,
    repoIds: [REPO_ID],
    lifecycle: 'ready',
    version: 1,
  })
}

async function createSession(channel: Channel): Promise<RuntimeSession> {
  const reply = await channel.execute(
    commandFor('dev.session.create', SCOPE_A, {
      projectId: PROJECT_ID,
      repoId: REPO_ID,
      worktreeId: randomUUID(),
    })
  )
  if (!reply.ok) throw new Error(`session create failed: ${JSON.stringify(reply.error)}`)
  return reply.value as RuntimeSession
}

function runRecord(scope: Scope, runtimeSessionId: string, state: HarnessRunState) {
  return {
    id: randomUUID(),
    scope,
    runtimeSessionId,
    installationId: randomUUID(),
    agentProfile: { id: 'default', version: 1, displayName: 'Default', capabilityPolicyVersion: 1 },
    state,
    generation: 1,
    startedAt: new Date().toISOString(),
    version: 1,
  }
}

function runsFile(dataDir: string): string {
  return join(dataDir, 'dev-runtime', 'harness', 'runs.json')
}

function seedRuns(dataDir: string, records: readonly unknown[]): void {
  mkdirSync(join(dataDir, 'dev-runtime', 'harness'), { recursive: true, mode: 0o700 })
  writeFileSync(
    runsFile(dataDir),
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), records }),
    { mode: 0o600 }
  )
}

function partitionName(scope: Scope): string {
  const key = JSON.stringify([scope.accountId, scope.workspaceId, scope.runtimeNodeId])
  return `authority-v2-${createHash('sha256').update(key).digest('hex')}.sqlite3`
}

async function seededBoot() {
  const booted = await boot()
  registerProject(booted.host)
  const live = await createSession(booted.channel)
  const archivedSource = await createSession(booted.channel)
  booted.host.projectSession?.upsertSession({
    ...archivedSource,
    archived: true,
    version: archivedSource.version + 1,
  })
  const otherSession = randomUUID()
  seedRuns(booted.dataDir, [
    // Active workspace: one running, one needs-input; the rest excluded.
    runRecord(SCOPE_A, live.id, 'working'),
    runRecord(SCOPE_A, live.id, 'awaiting_input'),
    runRecord(SCOPE_A, live.id, 'completed'),
    runRecord(SCOPE_A, live.id, 'unknown'),
    runRecord(SCOPE_A, archivedSource.id, 'working'),
    runRecord(SCOPE_A, randomUUID(), 'awaiting_approval'),
    // Sibling workspace (same account + node): counted by run state alone.
    runRecord(SCOPE_B, otherSession, 'starting'),
    runRecord(SCOPE_B, otherSession, 'resolving'),
    runRecord(SCOPE_B, otherSession, 'awaiting_approval'),
    runRecord(SCOPE_B, otherSession, 'awaiting_input'),
    runRecord(SCOPE_B, otherSession, 'failed'),
    runRecord(SCOPE_B, otherSession, 'cancelled'),
    runRecord(SCOPE_B, otherSession, 'disconnected'),
    // Another runtime node or account: never counted.
    runRecord(SCOPE_OTHER_NODE, otherSession, 'working'),
    runRecord(SCOPE_OTHER_NODE, otherSession, 'awaiting_input'),
    runRecord(SCOPE_OTHER_ACCOUNT, otherSession, 'working'),
    runRecord(SCOPE_OTHER_ACCOUNT, otherSession, 'awaiting_approval'),
  ])
  return booted
}

describe('dev.summary.workspaces through the gate', () => {
  test('counts per workspace for the same account and runtime node only', async () => {
    const { channel } = await seededBoot()
    const reply = await channel.execute(commandFor('dev.summary.workspaces', SCOPE_A))
    if (!reply.ok) throw new Error(JSON.stringify(reply.error))
    const summary = decodeWorkspaceRunSummary(reply.value)
    expect(summary.items).toEqual([
      { workspaceId: SCOPE_A.workspaceId, running: 1, needsInput: 1 },
      { workspaceId: SCOPE_B.workspaceId, running: 2, needsInput: 2 },
    ])
    const workspaces = summary.items.map((item) => item.workspaceId)
    expect(workspaces).not.toContain(SCOPE_OTHER_NODE.workspaceId)
    expect(workspaces).not.toContain(SCOPE_OTHER_ACCOUNT.workspaceId)
    // Counts only: exactly the workspace id and two integers per item.
    for (const item of summary.items)
      expect(Object.keys(item).toSorted()).toEqual(['needsInput', 'running', 'workspaceId'])
  })

  test('an empty registry answers with no items', async () => {
    const { channel } = await boot()
    const reply = await channel.execute(commandFor('dev.summary.workspaces', SCOPE_A))
    if (!reply.ok) throw new Error(JSON.stringify(reply.error))
    expect(decodeWorkspaceRunSummary(reply.value).items).toEqual([])
  })

  test('is registered as a provider, not as typed-unavailable', async () => {
    const { host } = await boot()
    expect(host.registration.matrix['dev.summary.workspaces']).toBe('provider')
  })

  test('deny-by-default: capability set must equal the registry', async () => {
    const { channel } = await seededBoot()
    for (const capabilities of [[], ['dev.harness.read'], ['dev.session.read']] as const) {
      const reply = await channel.execute(
        commandFor('dev.summary.workspaces', SCOPE_A, {}, { capabilities: [...capabilities] })
      )
      expect(reply.ok).toBe(false)
      // The strict frame decoder already pins the registry capability set
      // (refused as a malformed frame); the authority re-checks equality.
      if (!reply.ok) expect(['invalid_state', 'capability_denied']).toContain(reply.error.code)
      expect('value' in reply).toBe(false)
    }
  })

  test('refuses a body with extra keys, a resource binding, and a foreign scope', async () => {
    const { channel } = await seededBoot()
    for (const body of [{ workspaceId: SCOPE_B.workspaceId }, { includeNames: true }]) {
      const reply = await channel.execute(commandFor('dev.summary.workspaces', SCOPE_A, body))
      expect(reply.ok).toBe(false)
    }
    const bound = await channel.execute(
      commandFor(
        'dev.summary.workspaces',
        SCOPE_A,
        {},
        { resource: { kind: 'runtime_session', id: randomUUID(), generation: 1 } }
      )
    )
    expect(bound.ok).toBe(false)
    // A sibling workspace is counted, but is never an authorized scope for
    // the command itself: the identity binding admits only the active scope.
    const foreign = await channel.execute(commandFor('dev.summary.workspaces', SCOPE_B))
    expect(foreign.ok).toBe(false)
  })

  test('audits the read with the operation only — no workspace or count detail', async () => {
    const { channel, authority } = await seededBoot()
    const reply = await channel.execute(commandFor('dev.summary.workspaces', SCOPE_A))
    expect(reply.ok).toBe(true)
    const accepted = authority
      .auditSnapshot()
      .filter((record) => record.operation === 'dev.summary.workspaces')
    expect(accepted.map((record) => record.kind)).toEqual(['command_accepted'])
    expect(accepted[0]?.resource).toBeUndefined()
    expect(JSON.stringify(accepted)).not.toContain(SCOPE_B.workspaceId)
  })

  test('opens no other project/session partition and touches no other per-scope file', async () => {
    const { dataDir, channel } = await seededBoot()
    const partitionDir = join(dataDir, 'dev-runtime', 'project-session')
    // Plant sentinel partitions for every sibling scope. Opening any of them
    // as SQLite would fail closed (and retain a recovery copy); creating a
    // fresh partition would add a file. Either changes the directory.
    const sentinels = [SCOPE_B, SCOPE_OTHER_NODE, SCOPE_OTHER_ACCOUNT].map((scope) => {
      const file = join(partitionDir, partitionName(scope))
      writeFileSync(file, 'not a sqlite database', { mode: 0o600 })
      return file
    })
    const before = readdirSync(partitionDir).toSorted()
    const mtimes = sentinels.map((file) => statSync(file).mtimeMs)
    const runsBefore = readFileSync(runsFile(dataDir), 'utf8')

    const reply = await channel.execute(commandFor('dev.summary.workspaces', SCOPE_A))
    expect(reply.ok).toBe(true)

    expect(readdirSync(partitionDir).toSorted()).toEqual(before)
    sentinels.forEach((file, index) => {
      expect(readFileSync(file, 'utf8')).toBe('not a sqlite database')
      expect(statSync(file).mtimeMs).toBe(mtimes[index]!)
    })
    // The read never rewrites the shared registry either.
    expect(readFileSync(runsFile(dataDir), 'utf8')).toBe(runsBefore)
    expect(existsSync(join(partitionDir, partitionName(SCOPE_A)))).toBe(true)
  })

  test('by construction: the fold reads no files and no project/session authority', () => {
    const source = readFileSync(
      join(import.meta.dir, '../shell/src/dev-runtime/harness/workspace-summary.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/from 'node:fs'|from 'fs'|bun:sqlite|project-session/)
  })
})

describe('summarizeWorkspaceRuns', () => {
  const observedAt = '2026-10-05T12:00:00.000Z'
  const live = randomUUID()
  test('classifies attention vs running and drops terminal/unknown states', () => {
    const states: HarnessRunState[] = [
      'resolving',
      'starting',
      'working',
      'awaiting_input',
      'awaiting_approval',
      'completed',
      'failed',
      'cancelled',
      'disconnected',
      'unknown',
    ]
    const summary = summarizeWorkspaceRuns({
      runs: states.map((state) => ({ scope: SCOPE_B, runtimeSessionId: live, state })),
      activeScope: SCOPE_A,
      isActiveSessionLive: () => {
        throw new Error('never asked about another workspace')
      },
      observedAt,
    })
    expect(summary).toEqual({
      items: [{ workspaceId: SCOPE_B.workspaceId, running: 3, needsInput: 2 }],
      observedAt,
    })
  })

  test('asks only about active-scope sessions and excludes non-live ones', () => {
    const asked: string[] = []
    const archived = randomUUID()
    const summary = summarizeWorkspaceRuns({
      runs: [
        { scope: SCOPE_A, runtimeSessionId: live, state: 'working' },
        { scope: SCOPE_A, runtimeSessionId: archived, state: 'awaiting_input' },
        { scope: SCOPE_OTHER_NODE, runtimeSessionId: live, state: 'working' },
        { scope: SCOPE_OTHER_ACCOUNT, runtimeSessionId: live, state: 'working' },
      ],
      activeScope: SCOPE_A,
      isActiveSessionLive: (id) => {
        asked.push(id)
        return id === live
      },
      observedAt,
    })
    expect(asked.toSorted()).toEqual([archived, live].toSorted())
    expect(summary.items).toEqual([{ workspaceId: SCOPE_A.workspaceId, running: 1, needsInput: 0 }])
  })
})

describe('shared run registry', () => {
  test("a scope's write preserves every other scope's runs", () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'adea-summary-store-'))
    const storeA = createRunHistoryStore({ dataDir, scope: SCOPE_A })
    const storeB = createRunHistoryStore({ dataDir, scope: SCOPE_B })
    const runA = runRecord(SCOPE_A, randomUUID(), 'working')
    const runB = runRecord(SCOPE_B, randomUUID(), 'awaiting_input')
    storeA.append(runA as never)
    storeB.append(runB as never)
    storeA.observe({ runId: runA.id, to: 'completed', source: 'host', observedAt: observedNow() })
    expect(storeA.list().map((run) => run.id)).toEqual([runA.id])
    expect(storeB.list().map((run) => run.id)).toEqual([runB.id])
    expect(
      storeA
        .sameAccountAndNodeRuns()
        .map((run) => [run.scope.workspaceId, run.state])
        .toSorted()
    ).toEqual(
      [
        [SCOPE_A.workspaceId, 'completed'],
        [SCOPE_B.workspaceId, 'awaiting_input'],
      ].toSorted()
    )
  })
})

function observedNow(): string {
  return new Date().toISOString()
}
