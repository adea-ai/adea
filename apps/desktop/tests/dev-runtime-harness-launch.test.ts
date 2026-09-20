// Harness launch orchestration acceptance (#400).
//
// Boots the real composition graph and drives the preference/launch surface
// through the M10 gate with signed frames (fake drivers only — no real Pi
// download, no real ACP harness):
// - the clean-desktop root default: managed Pi is the effective enabled
//   global default before any user preference exists (owner decision), and
//   `dev.session.launchDefault` launches it;
// - discovered user-installed harnesses enter the ordering only through user
//   action (`dev.harness.preferenceUpdate`), and an explicit default is
//   authoritative — an unlaunchable one refuses with its typed reason instead
//   of silently launching something else;
// - observed run-status transitions (`dev.harness.runStatus`) follow the
//   canonical machine: legal edges apply, illegal edges and terminal states
//   refuse, everything is scope/resource/generation fenced;
// - reset-to-discovered restores managed-Pi-first.
import { describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { createChannelAuthority } from '../shell/src/dev-runtime/channel/authority'
import {
  createDesktopIdentityAuthority,
  type DesktopIdentityVerifier,
} from '../shell/src/dev-runtime/channel/identity'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'
import { createManagedPiDriver } from '../shell/src/dev-runtime/harness/managed-pi-driver'
import type { AcpLaneDriver } from '../shell/src/dev-runtime/harness/acp-lane'
import type { WorktreeService } from '../shell/src/dev-runtime/worktrees/service'

const SHELL_HOST = '127.0.0.1'
const SHELL_PORT = 4793
const SHELL_ORIGIN = `http://${SHELL_HOST}:${SHELL_PORT}`

const SCOPE_A: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const OTHER_SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000099',
  workspaceId: '00000000-0000-4000-8000-000000000098',
  runtimeNodeId: '00000000-0000-4000-8000-000000000097',
}

const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-harness-0000-0000-0002',
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
}

const PINNED_ARCHIVE = new TextEncoder().encode('adea-managed-pi-placeholder-archive-v1')
const DEFAULT_ARCHIVE = () => Promise.resolve(PINNED_ARCHIVE)

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
} as unknown as WorktreeService

function seedInventoryConnection(
  dataDir: string,
  scope: Scope,
  connection: {
    id: string
    auth?: 'ready' | 'required' | 'expired' | 'unknown'
    health?: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
    acpAvailability?: 'available' | 'adapter_required' | 'unavailable'
  }
): void {
  const entry = {
    id: connection.id,
    scope,
    family: 'claude',
    displayName: 'Claude Code (ACP)',
    driverId: 'local-executable',
    driverVersion: '1',
    provenance: 'user_managed',
    executableIdentity: '/opt/homebrew/bin/claude',
    executableLabel: 'claude',
    protocol: 'acp',
    acpAvailability: connection.acpAvailability ?? 'available',
    acpVersion: '1',
    version: '1.0.0',
    auth: connection.auth ?? 'ready',
    health: connection.health ?? 'healthy',
    compatibility: 'compatible',
    capabilities: ['native', 'acp', 'models', 'resume'],
    sessionOperations: ['session.new', 'session.resume'],
    entitlementHints: ['user_managed', 'native_auth'],
    limitations: [],
    transport: 'direct_local',
    models: [],
    observedAt: new Date().toISOString(),
    generation: 1,
  }
  const dir = join(dataDir, 'dev-runtime', 'discovery')
  const file = join(dir, 'inventory.json')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Merge with any already-seeded connections (id-addr replace).
  let records: unknown[] = []
  try {
    records = (JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown[] }).records ?? []
  } catch {
    records = []
  }
  const merged = [
    ...records.filter(
      (record) => (record as { entry?: { id?: string } }).entry?.id !== connection.id
    ),
    { kind: 'connection', entry },
  ]
  writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), records: merged })
  )
}

const noopAcpDriver: AcpLaneDriver = {
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
        processIdentity: 'scripted',
      },
    }
  },
  async close() {},
}

type Boot = {
  authority: ReturnType<typeof createChannelAuthority>
  host(): DevRuntimeHost
  dataDir: string
  managedPiStatus: () => ReturnType<NonNullable<DevRuntimeHost['harness']>['managedPi']['status']>
  openChannel(): Promise<{
    channelId: string
    clientCredentialId: string
    execute(command: DevCommand): Promise<DevReply>
  }>
}

async function boot(
  options: {
    archiveResolver?: (version: string) => Promise<Uint8Array | null>
    probeHost?: () => Promise<{ supported: boolean; reason?: string }>
    seedAcpInstallation?: Parameters<typeof seedInventoryConnection>[2]
  } = {}
): Promise<Boot> {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-harness-launch-'))
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
  if (options.seedAcpInstallation) {
    seedInventoryConnection(dataDir, SCOPE_A, options.seedAcpInstallation)
  }
  const host = createDevRuntimeHost({
    authority,
    gateway,
    dataDir,
    scope: identity.currentScope(),
    identity,
    approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
    runtimeRoot: join(dataDir, 'dev-runtime', 'runtime'),
    runLsof: () => Promise.resolve(''),
    resolveDns: () => Promise.resolve([]),
    worktreeService: fakeWorktreeService,
    managedPi: createManagedPiDriver({
      scope: SCOPE_A,
      dataDir,
      installRoot: join(dataDir, 'managed-pi-install'),
      ...(options.archiveResolver ? { resolvePinnedArchive: options.archiveResolver } : {}),
      ...(options.probeHost ? { probeHost: options.probeHost } : {}),
    }),
    acpDriver: noopAcpDriver,
  })
  mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })
  return {
    authority,
    host: () => host,
    dataDir,
    managedPiStatus: () => host.harness!.managedPi.status(),
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
        channelId,
        clientCredentialId,
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

async function createSession(
  host: DevRuntimeHost,
  channel: Awaited<ReturnType<Boot['openChannel']>>
) {
  host.projectSession?.upsertProject({
    id: '00000000-0000-4000-8000-0000000000aa',
    scope: SCOPE_A,
    name: 'Launch Project',
    groupIds: [],
    repoIds: ['00000000-0000-4000-8000-0000000000ab'],
    lifecycle: 'ready',
    version: 1,
  })
  const reply = await channel.execute(
    commandFor('dev.session.create', SCOPE_A, {
      projectId: '00000000-0000-4000-8000-0000000000aa',
      repoId: '00000000-0000-4000-8000-0000000000ab',
      worktreeId: randomUUID(),
    })
  )
  if (!reply.ok) throw new Error(`session create failed: ${JSON.stringify(reply.error)}`)
  return reply.value as { id: string; generation: number; version: number; projectId: string }
}

function sessionResource(session: { id: string; generation: number }) {
  return { kind: 'runtime_session', id: session.id, generation: session.generation }
}

function okValue(reply: DevReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(`expected ok reply: ${JSON.stringify(reply.error)}`)
  return reply.value as Record<string, unknown>
}

function errorCode(reply: DevReply): string {
  if (reply.ok) throw new Error('expected error reply')
  return reply.error.code
}

describe('harness preferences and the root default (#400)', () => {
  test('a clean desktop resolves managed Pi as the enabled global default', async () => {
    const shell = await boot({ archiveResolver: DEFAULT_ARCHIVE })
    try {
      const channel = await shell.openChannel()
      await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
      const managedId = shell.managedPiStatus().installationId!
      const prefs = okValue(
        await channel.execute(commandFor('dev.harness.preferences', SCOPE_A, {}))
      )
      const items = prefs.items as Array<Record<string, unknown>>
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        harnessInstallationId: managedId,
        enabled: true,
        default: true,
      })
      expect(items[0]!.projectId).toBeUndefined()
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('launchDefault launches the managed root default and is idempotent', async () => {
    const shell = await boot({ archiveResolver: DEFAULT_ARCHIVE })
    try {
      const channel = await shell.openChannel()
      await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
      const session = await createSession(shell.host(), channel)
      const launched = okValue(
        await channel.execute(
          commandFor(
            'dev.session.launchDefault',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation,
              agentProfileId: 'profile-1',
              agentProfileVersion: 2,
            },
            { resource: sessionResource(session) }
          )
        )
      )
      expect(launched).toMatchObject({
        runtimeSessionId: session.id,
        installationId: shell.managedPiStatus().installationId,
        state: 'starting',
      })
      // Idempotent: the same default on a live run returns that run.
      const again = okValue(
        await channel.execute(
          commandFor(
            'dev.session.launchDefault',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation + 1,
              agentProfileId: 'profile-1',
              agentProfileVersion: 2,
            },
            { resource: { ...sessionResource(session), generation: session.generation + 1 } }
          )
        )
      )
      expect(again.id).toBe(launched.id)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('with no managed Pi and no user preference the typed gap names the install remediation', async () => {
    const shell = await boot({
      archiveResolver: () => Promise.resolve(null),
      probeHost: () => Promise.resolve({ supported: false, reason: 'no toolchain' }),
    })
    try {
      const channel = await shell.openChannel()
      const session = await createSession(shell.host(), channel)
      const refused = await channel.execute(
        commandFor(
          'dev.session.launchDefault',
          SCOPE_A,
          {
            runtimeSessionId: session.id,
            expectedGeneration: session.generation,
            agentProfileId: 'profile-1',
            agentProfileVersion: 1,
          },
          { resource: sessionResource(session) }
        )
      )
      expect(errorCode(refused)).toBe('capability_unavailable')
      if (!refused.ok) {
        expect(refused.error.remediation?.action).toBe('dev.harness.managedPiInstall')
      }
      // No run record was fabricated.
      const runs = okValue(await channel.execute(commandFor('dev.harness.runs', SCOPE_A, {})))
      expect((runs.items as unknown[]).length).toBe(0)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a user preference becomes the authoritative default; reset restores managed-Pi-first', async () => {
    const installationId = randomUUID()
    const shell = await boot({
      archiveResolver: DEFAULT_ARCHIVE,
      seedAcpInstallation: { id: installationId },
    })
    try {
      const channel = await shell.openChannel()
      await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
      const session = await createSession(shell.host(), channel)

      // Unknown installation refuses.
      const unknown = await channel.execute(
        commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
          installationId: randomUUID(),
          expectedVersion: 0,
          patch: { enabled: true },
        })
      )
      expect(errorCode(unknown)).toBe('not_found')

      // Create is addressed as version 0; setting the default clears the
      // synthesized-managed default's role on the next resolution.
      const created = okValue(
        await channel.execute(
          commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
            installationId,
            expectedVersion: 0,
            patch: { enabled: true, default: true, modelId: 'claude-sonnet-4-6' },
          })
        )
      )
      expect(created).toMatchObject({
        harnessInstallationId: installationId,
        enabled: true,
        default: true,
        modelId: 'claude-sonnet-4-6',
        version: 1,
      })

      // Version fence: a stale expectedVersion refuses with the current one.
      const stale = await channel.execute(
        commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
          installationId,
          expectedVersion: 0,
          patch: { enabled: false },
        })
      )
      expect(errorCode(stale)).toBe('stale_version')

      // launchDefault launches the USER default with the preference's model.
      const launched = okValue(
        await channel.execute(
          commandFor(
            'dev.session.launchDefault',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation,
              agentProfileId: 'profile-2',
              agentProfileVersion: 1,
            },
            { resource: sessionResource(session) }
          )
        )
      )
      expect(launched).toMatchObject({
        installationId,
        modelId: 'claude-sonnet-4-6',
      })

      // Reset-to-discovered clears the stored overlay: the effective page
      // returns to managed-Pi-first and later launches use it.
      const reset = okValue(
        await channel.execute(commandFor('dev.harness.preferenceReset', SCOPE_A, {}))
      )
      const resetItems = reset.items as Array<Record<string, unknown>>
      expect(resetItems).toHaveLength(1)
      expect(resetItems[0]).toMatchObject({
        harnessInstallationId: shell.managedPiStatus().installationId,
        default: true,
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('a disabled default is never auto-launched; resolution falls back to the root default', async () => {
    const installationId = randomUUID()
    const shell = await boot({
      archiveResolver: DEFAULT_ARCHIVE,
      seedAcpInstallation: { id: installationId },
    })
    try {
      const channel = await shell.openChannel()
      await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
      const session = await createSession(shell.host(), channel)
      okValue(
        await channel.execute(
          commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
            installationId,
            expectedVersion: 0,
            patch: { enabled: false, default: true },
          })
        )
      )
      // The disabled default is skipped, not launched.
      const launched = okValue(
        await channel.execute(
          commandFor(
            'dev.session.launchDefault',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation,
              agentProfileId: 'profile-1',
              agentProfileVersion: 1,
            },
            { resource: sessionResource(session) }
          )
        )
      )
      expect(launched.installationId).toBe(shell.managedPiStatus().installationId)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('an explicit default that is not launchable refuses with its typed reason', async () => {
    const authRequired = randomUUID()
    const unhealthy = randomUUID()
    const shell = await boot({
      archiveResolver: DEFAULT_ARCHIVE,
      seedAcpInstallation: { id: authRequired, auth: 'required' },
    })
    try {
      const channel = await shell.openChannel()
      const session = await createSession(shell.host(), channel)
      // Install a second connection with bad health for the second refusal.
      seedInventoryConnection(shell.dataDir, SCOPE_A, { id: unhealthy, health: 'unhealthy' })
      okValue(
        await channel.execute(
          commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
            installationId: authRequired,
            expectedVersion: 0,
            patch: { enabled: true, default: true },
          })
        )
      )
      const authRefused = await channel.execute(
        commandFor(
          'dev.session.launchDefault',
          SCOPE_A,
          {
            runtimeSessionId: session.id,
            expectedGeneration: session.generation,
            agentProfileId: 'profile-1',
            agentProfileVersion: 1,
          },
          { resource: sessionResource(session) }
        )
      )
      expect(errorCode(authRefused)).toBe('auth_required')

      // Swap the default to the unhealthy installation: same refusal shape.
      okValue(
        await channel.execute(
          commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
            installationId: authRequired,
            expectedVersion: 1,
            patch: { default: false },
          })
        )
      )
      okValue(
        await channel.execute(
          commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
            installationId: unhealthy,
            expectedVersion: 0,
            patch: { enabled: true, default: true },
          })
        )
      )
      const healthRefused = await channel.execute(
        commandFor(
          'dev.session.launchDefault',
          SCOPE_A,
          {
            runtimeSessionId: session.id,
            expectedGeneration: session.generation,
            agentProfileId: 'profile-1',
            agentProfileVersion: 1,
          },
          { resource: sessionResource(session) }
        )
      )
      expect(errorCode(healthRefused)).toBe('unavailable')
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('preference reset-to-defaults contract (#400 residue)', () => {
  const PROJECT_B = '00000000-0000-4000-8000-0000000000ac'

  async function expressPreferences(
    channel: Awaited<ReturnType<Boot['openChannel']>>,
    installationId: string
  ) {
    // A global default with a preferred model plus a project-scoped default:
    // the full stored overlay.
    okValue(
      await channel.execute(
        commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
          installationId,
          expectedVersion: 0,
          patch: { enabled: true, default: true, modelId: 'test-model' },
        })
      )
    )
    okValue(
      await channel.execute(
        commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
          installationId,
          expectedVersion: 0,
          projectId: PROJECT_B,
          patch: { enabled: true, default: true },
        })
      )
    )
  }

  test('scope-wide reset clears the whole stored overlay; nothing but managed-Pi-first remains', async () => {
    const installationId = randomUUID()
    const shell = await boot({
      archiveResolver: DEFAULT_ARCHIVE,
      seedAcpInstallation: { id: installationId },
    })
    try {
      const channel = await shell.openChannel()
      await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
      await expressPreferences(channel, installationId)
      expect(
        (
          okValue(await channel.execute(commandFor('dev.harness.preferences', SCOPE_A, {})))
            .items as unknown[]
        ).length
      ).toBe(2)

      // Reset the WHOLE overlay.
      const reset = okValue(
        await channel.execute(commandFor('dev.harness.preferenceReset', SCOPE_A, {}))
      )
      const items = reset.items as Array<Record<string, unknown>>
      // Exactly the synthesized managed root default remains: no user record
      // (enabled flag, ordering, global/project defaults, preferred model)
      // survived — those live only in the cleared overlay.
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        harnessInstallationId: shell.managedPiStatus().installationId,
        enabled: true,
        default: true,
      })
      expect(items[0]!.projectId).toBeUndefined()

      // Reset returns to version-0 addressing: the installation is
      // re-addressable fresh, with no stale-version memory.
      const recreated = okValue(
        await channel.execute(
          commandFor('dev.harness.preferenceUpdate', SCOPE_A, {
            installationId,
            expectedVersion: 0,
            patch: { enabled: true },
          })
        )
      )
      expect(recreated).toMatchObject({ version: 1, enabled: true })

      // What persists: the managed installation stays ready (discovery and
      // runs are never touched by a preference reset).
      expect(shell.managedPiStatus()).toMatchObject({ state: 'ready' })
      okValue(await channel.execute(commandFor('dev.harness.runs', SCOPE_A, {})))
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('per-project reset clears only that project slice; global defaults persist', async () => {
    const installationId = randomUUID()
    const shell = await boot({
      archiveResolver: DEFAULT_ARCHIVE,
      seedAcpInstallation: { id: installationId },
    })
    try {
      const channel = await shell.openChannel()
      await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
      await expressPreferences(channel, installationId)

      const reset = okValue(
        await channel.execute(
          commandFor('dev.harness.preferenceReset', SCOPE_A, { projectId: PROJECT_B })
        )
      )
      const items = reset.items as Array<Record<string, unknown>>
      // The global default record survives; the project slice is gone.
      expect(items.some((item) => item.projectId === undefined && item.default === true)).toBe(true)
      expect(items.some((item) => item.projectId === PROJECT_B)).toBe(false)

      // The surviving global default still resolves for a project launch.
      const session = await createSession(shell.host(), channel)
      const launched = okValue(
        await channel.execute(
          commandFor(
            'dev.session.launchDefault',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation,
              agentProfileId: 'profile-1',
              agentProfileVersion: 1,
            },
            { resource: sessionResource(session) }
          )
        )
      )
      expect(launched.installationId).toBe(installationId)
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('reset without any stored preference is an idempotent no-op', async () => {
    const shell = await boot({ archiveResolver: DEFAULT_ARCHIVE })
    try {
      const channel = await shell.openChannel()
      await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
      const reset = okValue(
        await channel.execute(commandFor('dev.harness.preferenceReset', SCOPE_A, {}))
      )
      const items = reset.items as Array<Record<string, unknown>>
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        harnessInstallationId: shell.managedPiStatus().installationId,
        default: true,
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('observed run status through the gate (#400)', () => {
  async function launchFirst(shell: Boot, channel: Awaited<ReturnType<Boot['openChannel']>>) {
    await channel.execute(commandFor('dev.harness.managedPiInstall', SCOPE_A, {}))
    const session = await createSession(shell.host(), channel)
    const run = okValue(
      await channel.execute(
        commandFor(
          'dev.session.launchDefault',
          SCOPE_A,
          {
            runtimeSessionId: session.id,
            expectedGeneration: session.generation,
            agentProfileId: 'profile-1',
            agentProfileVersion: 1,
          },
          { resource: sessionResource(session) }
        )
      )
    )
    // The launch activates the session: the live generation is bumped.
    const live = { ...session, generation: session.generation + 1 }
    return { session: live, run: run as Record<string, unknown> }
  }

  function statusCommand(
    session: { id: string; generation: number },
    runId: string,
    state: string,
    overrides: Partial<DevCommand> = {}
  ): DevCommand {
    return commandFor(
      'dev.harness.runStatus',
      SCOPE_A,
      {
        runtimeSessionId: session.id,
        expectedGeneration: session.generation,
        harnessRunId: runId,
        state,
        source: 'acp',
      },
      { resource: sessionResource(session), ...overrides }
    )
  }

  test('legal transitions apply, stamp completion, and feed the canonical event stream', async () => {
    const shell = await boot({ archiveResolver: DEFAULT_ARCHIVE })
    try {
      const channel = await shell.openChannel()
      const { session, run } = await launchFirst(shell, channel)
      const runId = String(run.id)
      // starting → working (an observed structured-transport fact).
      const working = okValue(await channel.execute(statusCommand(session, runId, 'working')))
      expect(working).toMatchObject({ id: runId, state: 'working' })
      // working → awaiting_input → working → completed.
      expect(
        okValue(await channel.execute(statusCommand(session, runId, 'awaiting_input')))
      ).toMatchObject({ state: 'awaiting_input' })
      expect(
        okValue(await channel.execute(statusCommand(session, runId, 'working')))
      ).toMatchObject({ state: 'working' })
      const completed = okValue(
        await channel.execute(
          commandFor(
            'dev.harness.runStatus',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation,
              harnessRunId: runId,
              state: 'completed',
              source: 'native',
            },
            { resource: sessionResource(session) }
          )
        )
      )
      expect(completed).toMatchObject({ state: 'completed' })
      expect(typeof completed.finishedAt).toBe('string')

      // The transitions surfaced as canonical events on the session stream.
      const events = shell.host().harness!.events.read(session.id)
      const kinds = events.map((event) => event.kind)
      expect(kinds).toContain('run.created')
      expect(kinds).toContain('run.starting')
      expect(kinds).toContain('run.ready')
      expect(kinds).toContain('run.completed')
      expect(kinds).toContain('session.completed')

      // Idempotent same-state observation returns the run unchanged.
      const replay = await channel.execute(
        commandFor(
          'dev.harness.runStatus',
          SCOPE_A,
          {
            runtimeSessionId: session.id,
            expectedGeneration: session.generation,
            harnessRunId: runId,
            state: 'completed',
            source: 'native',
          },
          { resource: sessionResource(session) }
        )
      )
      expect(errorCode(replay)).toBe('already_completed')

      // The run history lists the terminal state with pagination bounds.
      const runs = okValue(
        await channel.execute(
          commandFor('dev.harness.runs', SCOPE_A, { runtimeSessionId: session.id })
        )
      )
      expect((runs.items as Array<Record<string, unknown>>)[0]).toMatchObject({
        state: 'completed',
      })
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('illegal transitions, terminal reruns, and gate negatives fail closed', async () => {
    const shell = await boot({ archiveResolver: DEFAULT_ARCHIVE })
    try {
      const channel = await shell.openChannel()
      const { session, run } = await launchFirst(shell, channel)
      const runId = String(run.id)

      // starting → completed is not a canonical edge (it never ran).
      const illegal = await channel.execute(statusCommand(session, runId, 'completed'))
      expect(errorCode(illegal)).toBe('invalid_state')

      // Advance to working, then attempt a rewind: working → starting is a
      // rewind, not a fact.
      okValue(await channel.execute(statusCommand(session, runId, 'working')))
      const rewind = await channel.execute(statusCommand(session, runId, 'starting'))
      expect(errorCode(rewind)).toBe('invalid_state')

      // Stale generation refuses before the machine runs.
      const stale = await channel.execute(
        statusCommand({ ...session, generation: session.generation + 9 }, runId, 'working')
      )
      expect(errorCode(stale)).toBe('stale_generation')

      // Foreign scope refuses at the gate.
      const foreign = await channel.execute(
        commandFor(
          'dev.harness.runStatus',
          OTHER_SCOPE,
          {
            runtimeSessionId: session.id,
            expectedGeneration: session.generation,
            harnessRunId: runId,
            state: 'working',
            source: 'acp',
          },
          { resource: sessionResource(session) }
        )
      )
      expect(errorCode(foreign)).toBe('channel_unauthorized')

      // A foreign run id is not_found, never a cross-session mutation.
      const foreignRun = await channel.execute(statusCommand(session, randomUUID(), 'working'))
      expect(errorCode(foreignRun)).toBe('not_found')

      // Terminal: cancel then observe → already_completed.
      const cancelled = okValue(
        await channel.execute(
          commandFor(
            'dev.session.cancelHarness',
            SCOPE_A,
            {
              runtimeSessionId: session.id,
              expectedGeneration: session.generation,
              harnessRunId: runId,
            },
            { resource: sessionResource(session) }
          )
        )
      )
      expect(cancelled).toMatchObject({ state: 'cancelled' })
      // Cancel bumped the live generation (to +1): a stale binding refuses
      // first, and under the live generation the terminal run refuses
      // re-observation.
      const fenced = await channel.execute(
        statusCommand({ ...session, generation: session.generation + 5 }, runId, 'working')
      )
      expect(errorCode(fenced)).toBe('stale_generation')
      const rerun = await channel.execute(
        statusCommand({ ...session, generation: session.generation + 1 }, runId, 'working')
      )
      expect(errorCode(rerun)).toBe('already_completed')
    } finally {
      rmSync(shell.dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
