// Workspace connections through the full composition (ADR 0012).
//
// Pins, over the real M10 channel, the real composition, the real in-process
// terminal sidecar, and a fake PTY:
// - a harness launch with `attachTerminal` resolves the workspace's account
//   profile for its family and delivers exactly that profile's vaulted key
//   into the PTY child's sanitized environment — and nowhere else: not the
//   run record, not an event, not the audit trail, not any persisted file;
// - run provenance records the resolved profile id and `accountConnection`;
// - an unbound workspace launches on `device_default` with no credential env;
// - a bound-but-revoked account refuses the launch (fails closed);
// - gh children receive the workspace token only for the bound host;
// - the channel refuses forged capabilities for every connection operation.
import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type DevReply,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier, type OwnerApproval } from '../shell/src/dev-runtime/authority'
import { createInMemoryVaultKeyStore } from '../shell/src/dev-runtime/vault'
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import type { GhRunner } from '../shell/src/dev-runtime/github/register'
import { createManagedPiDriver } from '../shell/src/dev-runtime/harness/managed-pi-driver'
import { connectSidecarClient } from '../shell/src/dev-runtime/terminal/sidecar/client'
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
const SHELL_PORT = 4817
const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`
const SCOPE_A: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-connections-0000-0001',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}
const PINNED_ARCHIVE = new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')
const WORKTREE_ID = '00000000-0000-4000-8000-0000000000bb'
const PROJECT_ID = '00000000-0000-4000-8000-0000000000aa'
const REPO_ID = '00000000-0000-4000-8000-0000000000ab'
const WORKTREE_ROOT = '/tmp/adea-connections-worktree'
const API_SECRET = `sk-ant-${randomBytes(16).toString('hex')}`
const OTHER_SECRET = `sk-ant-${randomBytes(16).toString('hex')}`
const GH_SECRET = `ghp_${randomBytes(16).toString('hex')}`

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
  listRepos: () => [],
} as unknown as WorktreeService

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

function okValue(reply: DevReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`expected ok reply: ${JSON.stringify(reply.error)}`)
  return reply.value as Record<string, unknown>
}

function errorOf(reply: DevReply): { code: string; message: string } {
  if (reply.ok) throw new Error('expected error reply')
  return reply.error as { code: string; message: string }
}

async function boot(options: { runGh?: GhRunner } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-connections-launch-'))
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
  const verifier: DesktopIdentityVerifier = {
    async verifySession() {
      return [SCOPE_A.workspaceId]
    },
    async verifyNodeEligibility() {
      return
    },
  }
  const identity = createDesktopIdentityAuthority({ dataDir, verifier })
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

  const fake = createFakePtyAdapter()
  const credential = newSidecarCredential()
  const service = createSidecarService({
    runtimeRoot: join(dataDir, 'dev-runtime'),
    ptyAdapter: fake.adapter,
    sidecarVersion: '1.0.0-test',
    credential,
    executableIdentity: 'sidecar@connections-test',
    pidStartIdentity: 'connections-test-identity',
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

  const approvalVerifier = createOwnerApprovalVerifier({ dataDir })
  const host: DevRuntimeHost = createDevRuntimeHost({
    credentialStore: createInMemoryVaultKeyStore(),
    authority,
    gateway,
    dataDir,
    scope: identity.currentScope(),
    identity,
    approvalVerifier,
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    sidecar: connected.client,
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    worktreeService: fakeWorktreeService,
    ...(options.runGh ? { runGh: options.runGh } : {}),
    managedPi: createManagedPiDriver({
      scope: SCOPE_A,
      dataDir,
      installRoot: join(dataDir, 'managed-pi-install'),
      resolvePinnedArchive: () => Promise.resolve(PINNED_ARCHIVE),
    }),
  })
  mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })

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
  const execute = (command: DevCommand) =>
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
    )

  let consent = 0
  const enroll = (hostName: string, secretValue: string, kind: 'other' | 'github_token') => {
    const approval: OwnerApproval = {
      method: 'owner_dialog',
      reference: `consent-${++consent}`,
      scope: SCOPE_A,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    approvalVerifier.recordIssuance(approval, SCOPE_A, 'enroll a credential')
    return host.vault.enroll({
      scope: SCOPE_A,
      label: `${hostName} ${consent}`,
      host: hostName,
      kind,
      secret: secretValue,
      approval,
    })
  }

  const persistedText = () => {
    const chunks: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const stats = statSync(path)
        if (stats.isDirectory()) walk(path)
        else if (stats.isFile()) chunks.push(readFileSync(path).toString('latin1'))
      }
    }
    walk(dataDir)
    return chunks.join('\n')
  }

  return {
    host,
    dataDir,
    execute,
    enroll,
    persistedText,
    spawnInputs: () => fake.spawnInputs,
    dispose: () => {
      connected.client.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

type Shell = Awaited<ReturnType<typeof boot>>

async function readySession(shell: Shell): Promise<{ id: string; generation: number }> {
  shell.host.projectSession?.upsertProject({
    id: PROJECT_ID,
    scope: SCOPE_A,
    repoIds: [REPO_ID],
    lifecycle: 'ready',
    version: 1,
  })
  const session = okValue(
    await shell.execute(
      commandFor('dev.session.create', {
        projectId: PROJECT_ID,
        repoId: REPO_ID,
        worktreeId: WORKTREE_ID,
      })
    )
  ) as unknown as { id: string; generation: number }
  okValue(await shell.execute(commandFor('dev.harness.managedPiInstall', {})))
  return session
}

function launch(shell: Shell, session: { id: string; generation: number }) {
  const installationId = shell.host.harness!.managedPi.status().installationId!
  return shell.execute(
    commandFor(
      'dev.session.launchHarness',
      {
        runtimeSessionId: session.id,
        expectedGeneration: session.generation,
        harnessInstallationId: installationId,
        agentProfileId: 'profile-1',
        agentProfileVersion: 1,
        attachTerminal: true,
      },
      { resource: { kind: 'runtime_session', id: session.id, generation: session.generation } }
    )
  )
}

async function bindAccount(shell: Shell, secretValue: string) {
  const ref = shell.enroll('api.anthropic.com', secretValue, 'other')
  const profile = okValue(
    await shell.execute(
      commandFor('dev.harness.accountProfiles.create', {
        harnessId: 'pi',
        label: `Work ${ref.id.slice(0, 4)}`,
        credentialRefId: ref.id,
      })
    )
  )
  const current = okValue(await shell.execute(commandFor('dev.connections.get', {})))
  okValue(
    await shell.execute(
      commandFor('dev.connections.setHarnessAccount', {
        harnessId: 'pi',
        profileId: profile.id,
        expectedVersion: current.version,
      })
    )
  )
  return { ref, profile }
}

describe('workspace harness accounts at launch', () => {
  test('the bound profile key reaches only the PTY child env; provenance records its id', async () => {
    const shell = await boot()
    try {
      const session = await readySession(shell)
      // A second, unbound profile must never be the one injected.
      shell.enroll('api.anthropic.com', OTHER_SECRET, 'other')
      const { profile } = await bindAccount(shell, API_SECRET)

      // The connections view lists the managed Pi family as connectable.
      const view = okValue(await shell.execute(commandFor('dev.connections.get', {})))
      expect(view.availableHarnesses).toContainEqual({
        harnessId: 'pi',
        displayName: 'Pi',
        accountHosts: ['api.anthropic.com', 'api.openai.com'],
      })

      const run = okValue(await launch(shell, session))
      expect(run.state).toBe('starting')
      const spawn = shell.spawnInputs()[0]!
      expect(spawn.env.ANTHROPIC_API_KEY).toBe(API_SECRET)
      expect(spawn.env.OPENAI_API_KEY).toBeUndefined()
      expect(Object.values(spawn.env)).not.toContain(OTHER_SECRET)
      // The run reply carries no secret.
      expect(JSON.stringify(run)).not.toContain(API_SECRET)

      const created = shell.host
        .harness!.events.read(session.id)
        .find((event) => event.kind === 'run.created')
      expect(created?.payload).toMatchObject({
        accountConnection: 'workspace',
        accountProfileId: profile.id,
        accountProfileVersion: 1,
        accountInjected: true,
      })
      // Never persisted, never logged: no file under the data dir holds it.
      expect(shell.persistedText()).not.toContain(API_SECRET)
    } finally {
      shell.dispose()
    }
  })

  test('an unbound workspace launches on the device default with no credential env', async () => {
    const shell = await boot()
    try {
      const session = await readySession(shell)
      okValue(await launch(shell, session))
      const spawn = shell.spawnInputs()[0]!
      expect(spawn.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(spawn.env.OPENAI_API_KEY).toBeUndefined()
      const created = shell.host
        .harness!.events.read(session.id)
        .find((event) => event.kind === 'run.created')
      expect(created?.payload).toMatchObject({ accountConnection: 'device_default' })
      expect(created?.payload).not.toHaveProperty('accountProfileId')
    } finally {
      shell.dispose()
    }
  })

  test('a bound account whose key was revoked refuses the launch', async () => {
    const shell = await boot()
    try {
      const session = await readySession(shell)
      const { ref } = await bindAccount(shell, API_SECRET)
      shell.host.vault.revoke({
        scope: SCOPE_A,
        credentialRefId: ref.id,
        expectedVersion: ref.version,
      })
      expect(errorOf(await launch(shell, session)).code).toBe('auth_required')
      expect(shell.spawnInputs()).toHaveLength(0)
    } finally {
      shell.dispose()
    }
  })
})

describe('workspace git hosting through the gh provider', () => {
  test('gh receives the workspace token for the bound host only', async () => {
    const calls: Array<{ args: readonly string[]; env?: Readonly<Record<string, string>> }> = []
    const runGh: GhRunner = async (args, options) => {
      calls.push({ args, ...(options?.env ? { env: options.env } : {}) })
      return { stdout: JSON.stringify({ login: 'octocat' }), stderr: '', exitCode: 0 }
    }
    const shell = await boot({ runGh })
    try {
      okValue(await shell.execute(commandFor('dev.github.account', {})))
      expect(calls[0]?.env).toBeUndefined()

      const ref = shell.enroll('github.com', GH_SECRET, 'github_token')
      okValue(
        await shell.execute(
          commandFor('dev.connections.setGitHosting', {
            host: 'github.com',
            credentialRefId: ref.id,
            expectedVersion: 0,
          })
        )
      )
      okValue(await shell.execute(commandFor('dev.github.account', {})))
      expect(calls).toHaveLength(2)
      expect(calls[1]!.env).toEqual({ GH_TOKEN: GH_SECRET })
      expect(calls[1]!.args).toContain('github.com')
      expect(shell.persistedText()).not.toContain(GH_SECRET)
    } finally {
      shell.dispose()
    }
  })
})

describe('connection operations through the channel', () => {
  test('forged capabilities are refused before any provider runs', async () => {
    const shell = await boot()
    try {
      const bodies: Record<string, Record<string, unknown>> = {
        'dev.connections.get': {},
        'dev.connections.setGitHosting': {
          host: 'github.com',
          credentialRefId: null,
          expectedVersion: 0,
        },
        'dev.connections.setHarnessAccount': {
          harnessId: 'pi',
          profileId: null,
          expectedVersion: 0,
        },
        'dev.harness.accountProfiles.list': {},
        'dev.harness.accountProfiles.create': {
          harnessId: 'pi',
          label: 'x',
          credentialRefId: randomUUID(),
        },
        'dev.harness.accountProfiles.delete': { profileId: randomUUID(), expectedVersion: 1 },
      }
      const operations = Object.keys(bodies) as DevOperation[]
      for (const operation of operations) {
        expect(shell.host.registration.matrix[operation]).toBe('provider')
        const reply = await shell.execute(
          commandFor(operation, bodies[operation], { capabilities: ['dev.files.read'] as never })
        )
        expect(reply.ok).toBe(false)
        // The strict command decoder refuses a capability set that is not the
        // registry's exact set, before any provider runs.
        expect(errorOf(reply)).toMatchObject({
          code: 'invalid_state',
          message: 'command frame was malformed',
        })
        // Another workspace's scope is refused at scope admission.
        const foreign = await shell.execute(
          commandFor(operation, bodies[operation], {
            scope: { ...SCOPE_A, workspaceId: '00000000-0000-4000-8000-00000000000b' },
          })
        )
        expect(foreign.ok).toBe(false)
        expect(errorOf(foreign).code).toBe('channel_unauthorized')
      }
    } finally {
      shell.dispose()
    }
  })
})
