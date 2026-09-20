// Control-plane composition acceptance: boots the actual shell registration
// graph (channel authority → identity authority → gateway → Dev Runtime host
// composition, exactly as apps/desktop/shell/src/bun/index.ts wires it) and
// pins the operation/provider matrix. Every registry operation must be a
// reachable provider or a documented typed-unavailable host capability
// result; scope admission must precede capability checks; revoked nodes,
// rebinds, workspace switches, and unbinds must fail closed.
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
  type Scope,
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
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    ...(options.publish ? { publish: options.publish } : {}),
    ...(options.sidecar ? { sidecar: options.sidecar as never } : {}),
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
        'dev.group.list',
        'dev.project.list',
        'dev.project.get',
        'dev.project.reorder',
        'dev.project.bookmarks',
        'dev.repo.list',
        'dev.repo.credentialRefs',
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
      // The only unavailable files operations are the bulk-stream grants
      // (file-bytes-v1 attach is not wired on this host); every control-path
      // files/git operation is a reachable provider.
      const filesUnavailable = typedUnavailable.filter((operation) =>
        operation.startsWith('dev.files.')
      )
      expect(
        filesUnavailable.every(
          (operation) =>
            operation === 'dev.files.readStream' || operation === 'dev.files.writeStream'
        )
      ).toBe(true)
      expect(filesUnavailable.length).toBe(2)
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

  test('an unauthenticated local caller cannot bind, dispatch, or reuse credentials', async () => {
    const shell = await boot({ unbound: true })
    try {
      // No binding exists: the gate refuses before capability checks or
      // provider dispatch, and the refusal is the unauthenticated code.
      const channel = await shell.openChannel()
      const refused = await channel.execute(commandFor('dev.project.list', SCOPE_A, { limit: 10 }))
      expect(refused).toMatchObject({ ok: false, error: { code: 'unauthenticated' } })

      // The trust gate refuses a handshake from a foreign origin before the
      // bootstrap token is examined: loopback presence is not authority.
      expect(() => shell.authority.handshake({}, { trusted: false })).toThrow(
        'untrusted client origin'
      )
      // Binding with a credential the cloud refuses fails closed.
      const refusedVerifier = fakeCloudVerifier({ unreachable: true })
      const strict = createDesktopIdentityAuthority({
        dataDir: shell.dataDir + '-2',
        verifier: refusedVerifier,
      })
      await expect(strict.bind({ session: SESSION, claimed: SCOPE_A })).rejects.toMatchObject({
        code: 'runtime_node_unavailable',
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
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

      // Re-bind under a different workspace: the composition revokes every
      // channel minted under the previous binding.
      await shell.bind(SCOPE_B)
      const stale = await first.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(stale).toMatchObject({ ok: false, error: { code: 'channel_unauthenticated' } })

      // A fresh handshake under the new binding serves the new scope only.
      const second = await shell.openChannel()
      const rebound = await second.execute(commandFor('dev.project.list', SCOPE_B, {}))
      expect(rebound.ok).toBe(true)
      const oldScope = await second.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(oldScope).toMatchObject({ ok: false, error: { code: 'channel_unauthorized' } })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  })

  test('unbind (sign-out) fails the surface closed', async () => {
    const shell = await boot()
    try {
      const channel = await shell.openChannel()
      await shell.identity.unbind('owner sign-out')
      // The composition revoked every channel on unbind: reconnects fail
      // closed instead of inheriting the old authority.
      const refused = await channel.execute(commandFor('dev.project.list', SCOPE_A, {}))
      expect(refused).toMatchObject({ ok: false, error: { code: 'channel_unauthenticated' } })
      expect(shell.identity.currentScope()).toBeUndefined()
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
