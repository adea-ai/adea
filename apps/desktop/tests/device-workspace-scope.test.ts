// Device workspace scope (ADR 0011): `desktop_identity_select_workspace`
// activates `{ local accountId, cloud workspaceId, local runtimeNodeId }` only
// for a cloud workspace the presented credential is a verified member of.
// Pins the fail-closed refusals (non-member, offline-unverified, expired
// cache, malformed credential, a paired binding elsewhere), the channel drop
// and re-handshake on a scope switch through the real bridge script, the
// per-workspace partition file, and that the device-local guest partition is
// never read, rewritten, or deleted after the switch.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devOperationDefinitions,
  type DevCommand,
  type DevOperation,
  type Group,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { createOwnerApprovalVerifier } from '../shell/src/dev-runtime/authority'
import {
  ChannelRejection,
  createChannelAuthority,
} from '../shell/src/dev-runtime/channel/authority'
import {
  createCloudIdentityVerifier,
  createDesktopIdentityAuthority,
  IDENTITY_LIMITS,
  type DesktopIdentityVerifier,
  type MembershipProof,
  type WorkspaceMembershipCredential,
} from '../shell/src/dev-runtime/channel/identity'
import { createIdentityCommandSurface } from '../shell/src/dev-runtime/channel/identity-commands'
import { createChannelGateway } from '../shell/src/dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../shell/src/dev-runtime'

const WORKSPACE_A = '00000000-0000-4000-8000-0000000000a1'
const WORKSPACE_B = '00000000-0000-4000-8000-0000000000b2'
const FOREIGN = '00000000-0000-4000-8000-0000000000f3'
const TEMPORARY = `adea_tmp_${'g'.repeat(43)}`
const OTHER_TEMPORARY = `adea_tmp_${'h'.repeat(43)}`
const SESSION = {
  credential: 'c'.repeat(43),
  sessionId: 'sess-0000-0000-0000-0001',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
}
const guest = (credential = TEMPORARY): WorkspaceMembershipCredential => ({
  kind: 'temporary',
  credential,
})

/** A scripted cloud: each credential lists its member workspaces; the cloud
 *  can go offline (unreachable) or refuse a credential outright. */
function scriptedCloud(memberships: Record<string, readonly string[]>) {
  const state = { unreachable: false, refused: new Set<string>(), calls: 0 }
  const credentialOf = (proof: MembershipProof) =>
    proof.session ? proof.session.credential : proof.temporaryCredential
  const verifier: DesktopIdentityVerifier = {
    async verifySession(proof) {
      state.calls += 1
      if (state.unreachable) {
        throw new ChannelRejection('runtime_node_unavailable', 'cloud unreachable', 503, true)
      }
      const credential = credentialOf(proof)
      if (state.refused.has(credential)) {
        throw new ChannelRejection('unauthenticated', 'credential refused', 401)
      }
      return memberships[credential] ?? []
    },
    async verifyNodeEligibility() {
      throw new ChannelRejection('runtime_node_revoked', 'device scopes never pair', 403)
    },
  }
  return { verifier, state, memberships }
}

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adea-device-scope-'))
  cleanup.push(dir)
  return dir
}

describe('device workspace scope selection', () => {
  test('a verified member selects its cloud workspace on the local account and node', async () => {
    const cloud = scriptedCloud({ [TEMPORARY]: [WORKSPACE_A, WORKSPACE_B] })
    const identity = createDesktopIdentityAuthority({
      dataDir: tempDir(),
      verifier: cloud.verifier,
    })
    const local = identity.currentScope()
    const reasons: string[] = []
    identity.onBindingChanged((reason) => reasons.push(reason))

    const selected = await identity.selectWorkspace({
      workspaceId: WORKSPACE_A,
      credential: guest(),
    })
    expect(selected).toEqual({
      kind: 'device',
      scope: {
        accountId: local.accountId,
        workspaceId: WORKSPACE_A,
        runtimeNodeId: local.runtimeNodeId,
      },
    })
    expect(identity.identityKind()).toBe('device')
    expect(identity.currentScope()).toEqual(selected.scope)
    expect(reasons).toEqual(['selected'])
    // The gate admits exactly the selected scope; the guest scope is gone.
    identity.assertCommandScope(selected.scope)
    expect(() => identity.assertCommandScope(local)).toThrow('active identity binding')
    await identity.ensureNodeEligible()

    // Re-selecting the active workspace is not a scope change.
    await identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    expect(reasons).toEqual(['selected'])
  })

  test('a desktop session proves membership the same way', async () => {
    const cloud = scriptedCloud({ [SESSION.credential]: [WORKSPACE_B] })
    const identity = createDesktopIdentityAuthority({
      dataDir: tempDir(),
      verifier: cloud.verifier,
    })
    const selected = await identity.selectWorkspace({
      workspaceId: WORKSPACE_B,
      credential: { kind: 'desktop', session: SESSION },
    })
    expect(selected.scope.workspaceId).toBe(WORKSPACE_B)
    await expect(
      identity.selectWorkspace({
        workspaceId: WORKSPACE_B,
        credential: {
          kind: 'desktop',
          session: { ...SESSION, expiresAt: new Date(Date.now() - 1_000).toISOString() },
        },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  test('a non-member is refused and the active scope is unchanged', async () => {
    const cloud = scriptedCloud({ [TEMPORARY]: [WORKSPACE_A] })
    const identity = createDesktopIdentityAuthority({
      dataDir: tempDir(),
      verifier: cloud.verifier,
    })
    const before = identity.currentScope()
    const reasons: string[] = []
    identity.onBindingChanged((reason) => reasons.push(reason))

    await expect(
      identity.selectWorkspace({ workspaceId: FOREIGN, credential: guest() })
    ).rejects.toMatchObject({ code: 'unauthorized', httpStatus: 403 })
    expect(identity.currentScope()).toEqual(before)
    expect(identity.identityKind()).toBe('guest')
    expect(reasons).toEqual([])

    // Another credential's memberships never admit this one.
    await identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest(OTHER_TEMPORARY) })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  test('malformed workspace ids and credentials are refused before the cloud is asked', async () => {
    const cloud = scriptedCloud({ [TEMPORARY]: [WORKSPACE_A] })
    const identity = createDesktopIdentityAuthority({
      dataDir: tempDir(),
      verifier: cloud.verifier,
    })
    await expect(
      identity.selectWorkspace({ workspaceId: 'not-a-uuid', credential: guest() })
    ).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest('adea_tmp_short') })
    ).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(
      identity.selectWorkspace({
        workspaceId: WORKSPACE_A,
        credential: { kind: 'cloud' } as unknown as WorkspaceMembershipCredential,
      })
    ).rejects.toMatchObject({ code: 'invalid_state' })
    expect(cloud.state.calls).toBe(0)
  })

  test('offline selection admits only workspaces this credential already verified', async () => {
    const dataDir = tempDir()
    const cloud = scriptedCloud({ [TEMPORARY]: [WORKSPACE_A, WORKSPACE_B] })
    const identity = createDesktopIdentityAuthority({ dataDir, verifier: cloud.verifier })

    // Never verified: offline is refused with a typed, retryable error.
    cloud.state.unreachable = true
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    ).rejects.toMatchObject({ code: 'workspace_unavailable', retryable: true })
    expect(identity.identityKind()).toBe('guest')

    // One online verification caches every listed membership.
    cloud.state.unreachable = false
    await identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    cloud.state.unreachable = true
    const offline = await identity.selectWorkspace({
      workspaceId: WORKSPACE_B,
      credential: guest(),
    })
    expect(offline.scope.workspaceId).toBe(WORKSPACE_B)
    // ...but never a workspace the listing did not contain, nor for a
    // credential that did not prove it.
    await expect(
      identity.selectWorkspace({ workspaceId: FOREIGN, credential: guest() })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest(OTHER_TEMPORARY) })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(identity.currentScope().workspaceId).toBe(WORKSPACE_B)

    // The cache is durable state: a restarted shell keeps the selection and
    // still switches offline among verified workspaces.
    const restarted = createDesktopIdentityAuthority({ dataDir, verifier: cloud.verifier })
    expect(restarted.currentScope().workspaceId).toBe(WORKSPACE_B)
    await restarted.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    // The credential digest is the cache key; the credential never lands on disk.
    const cacheFile = readFileSync(join(dataDir, 'dev-runtime/identity/memberships.json'), 'utf8')
    expect(cacheFile).not.toContain(TEMPORARY)
  })

  test('the online listing is authoritative and a refused credential forgets its cache', async () => {
    const cloud = scriptedCloud({ [TEMPORARY]: [WORKSPACE_A, WORKSPACE_B] })
    const identity = createDesktopIdentityAuthority({
      dataDir: tempDir(),
      verifier: cloud.verifier,
    })
    await identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })

    // Membership in B was removed: the next online listing drops it.
    cloud.memberships[TEMPORARY] = [WORKSPACE_A]
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_B, credential: guest() })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    cloud.state.unreachable = true
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_B, credential: guest() })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })

    // The cloud refuses the credential: its cached proof stops admitting
    // offline selection, and the active device scope fails closed.
    cloud.state.unreachable = false
    cloud.state.refused.add(TEMPORARY)
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(identity.ensureNodeEligible()).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })
    cloud.state.unreachable = true
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })
  })

  test('cached memberships expire after the registry TTL', async () => {
    let now = Date.parse('2026-10-05T00:00:00.000Z')
    const cloud = scriptedCloud({ [TEMPORARY]: [WORKSPACE_A, WORKSPACE_B] })
    const identity = createDesktopIdentityAuthority({
      dataDir: tempDir(),
      verifier: cloud.verifier,
      now: () => now,
    })
    expect(IDENTITY_LIMITS.membershipCacheTtlMs).toBe(24 * 60 * 60 * 1_000)
    await identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    cloud.state.unreachable = true

    now += IDENTITY_LIMITS.membershipCacheTtlMs - 1
    await identity.selectWorkspace({ workspaceId: WORKSPACE_B, credential: guest() })
    await identity.ensureNodeEligible()

    now += 2
    await expect(
      identity.selectWorkspace({ workspaceId: WORKSPACE_A, credential: guest() })
    ).rejects.toMatchObject({ code: 'workspace_unavailable' })
    // The active selection keeps its scope (host and gate stay in agreement)
    // but every command now fails closed until membership is re-proven.
    expect(identity.currentScope().workspaceId).toBe(WORKSPACE_B)
    await expect(identity.ensureNodeEligible()).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })

    cloud.state.unreachable = false
    await identity.selectWorkspace({ workspaceId: WORKSPACE_B, credential: guest() })
    await identity.ensureNodeEligible()
  })

  test('a paired cloud binding takes precedence over device selection', async () => {
    const local = { accountId: randomUUID(), runtimeNodeId: randomUUID() }
    const bound: Scope = { ...local, workspaceId: WORKSPACE_A }
    const verifier: DesktopIdentityVerifier = {
      async verifySession() {
        return [WORKSPACE_A, WORKSPACE_B]
      },
      async verifyNodeEligibility() {},
    }
    const identity = createDesktopIdentityAuthority({ dataDir: tempDir(), verifier })
    await identity.bind({ session: SESSION, claimed: bound })
    expect(identity.identityKind()).toBe('cloud')

    await expect(
      identity.selectWorkspace({
        workspaceId: WORKSPACE_B,
        credential: { kind: 'desktop', session: SESSION },
      })
    ).rejects.toMatchObject({ code: 'identity_mismatch' })
    expect(identity.currentScope()).toEqual(bound)

    // Selecting the bound workspace leaves the binding in charge.
    const same = await identity.selectWorkspace({
      workspaceId: WORKSPACE_A,
      credential: { kind: 'desktop', session: SESSION },
    })
    expect(same).toEqual({ kind: 'cloud', scope: bound })

    // Unbinding falls back to the device selection, not the guest scope.
    identity.unbind('owner sign-out')
    expect(identity.identityKind()).toBe('device')
    expect(identity.currentScope().workspaceId).toBe(WORKSPACE_A)
  })
})

describe('cloud membership verifier', () => {
  test('presents the guest credential or the desktop session to the workspace listing', async () => {
    const seen: Array<Record<string, string>> = []
    let status = 200
    const verifier = createCloudIdentityVerifier({
      cloudOrigin: 'https://cloud.example',
      shellOrigin: 'http://127.0.0.1:4789',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://cloud.example/api/workspaces')
        seen.push({ ...(init?.headers as Record<string, string>) })
        return Response.json([{ id: WORKSPACE_A }, { id: 7 }], { status })
      }) as typeof fetch,
    })
    expect(await verifier.verifySession({ temporaryCredential: TEMPORARY })).toEqual([WORKSPACE_A])
    expect(seen[0]).toMatchObject({
      authorization: `Temporary ${TEMPORARY}`,
      origin: 'http://127.0.0.1:4789',
      'x-adea-client': 'desktop',
    })
    expect(seen[0]).not.toHaveProperty('x-adea-desktop-session')
    await verifier.verifySession({ session: SESSION })
    expect(seen[1]).toMatchObject({
      authorization: `Desktop ${SESSION.credential}`,
      'x-adea-desktop-session': SESSION.sessionId,
    })
    status = 401
    await expect(verifier.verifySession({ temporaryCredential: TEMPORARY })).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })
})

function commandFor(
  operation: DevOperation,
  scope: Scope,
  body: Record<string, unknown> = {}
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
  } as DevCommand
}

function partitionFiles(dataDir: string): Map<string, { digest: string; mtimeMs: number }> {
  const directory = join(dataDir, 'dev-runtime', 'project-session')
  const files = new Map<string, { digest: string; mtimeMs: number }>()
  if (!existsSync(directory)) return files
  for (const name of readdirSync(directory)) {
    if (!name.startsWith('authority-')) continue
    const path = join(directory, name)
    files.set(name, {
      digest: createHash('sha256').update(readFileSync(path)).digest('hex'),
      mtimeMs: statSync(path).mtimeMs,
    })
  }
  return files
}

describe('device workspace scope through the shell entry', () => {
  test('a switch drops old channels, re-handshakes the bridge, and opens a new partition', async () => {
    const dataDir = tempDir()
    mkdirSync(join(dataDir, 'dev-runtime', 'runtime'), { recursive: true })
    const cloud = scriptedCloud({ [TEMPORARY]: [WORKSPACE_A, WORKSPACE_B] })
    const identity = createDesktopIdentityAuthority({ dataDir, verifier: cloud.verifier })

    let gateway!: ReturnType<typeof createChannelGateway>
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, bunServer) =>
        gateway.handle(request, (req, data) => bunServer.upgrade(req, { data })),
      websocket: {
        open: (socket) => gateway?.websockets.open(socket),
        message: (socket, message) => gateway?.websockets.message(socket, message),
        close: (socket) => gateway?.websockets.close(socket),
      },
    })
    try {
      const shellOrigin = `http://127.0.0.1:${server.port}`
      const authority = createChannelAuthority({
        shellHost: `127.0.0.1:${server.port}`,
        shellOrigin,
        authorizeCommand: async (command) => {
          identity.assertCommandScope(command.scope)
          await identity.ensureNodeEligible()
        },
      })
      // Mirrors bun/index.ts: the identity family routes before the rest.
      const identityCommands = createIdentityCommandSurface({
        identity,
        issueRehandshake: () => gateway.bootstrapToken(),
      })
      gateway = createChannelGateway({
        authority,
        invoke: async (cmd, args) =>
          identityCommands.handles(cmd)
            ? identityCommands.invoke(cmd, args)
            : { ok: true, value: null },
        shellOrigin,
      })
      const compositionInput = {
        authority,
        gateway,
        dataDir,
        scope: identity.currentScope(),
        identity,
        approvalVerifier: createOwnerApprovalVerifier({ dataDir }),
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
      }
      let host: DevRuntimeHost = createDevRuntimeHost(compositionInput)
      identity.onBindingChanged(() => {
        host = createDevRuntimeHost({ ...compositionInput, scope: identity.currentScope() })
      })

      const window: Record<string, unknown> = {
        __ADEA_LAUNCH_BOOTSTRAP__: gateway.bootstrapToken(),
      }
      new Function('window', 'EventSource', gateway.bridgeScript())(
        window,
        function EventSource() {}
      )
      const bridge = window.__adeaDesktop as {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
        devExecute: (command: DevCommand) => Promise<{ ok: boolean; error?: { code: string } }>
      }

      // Signed-out boot: the device-local guest scope owns a partition.
      const guestScope = (await bridge.invoke('desktop_identity_scope')) as Scope
      const guestGroup: Group = {
        id: randomUUID(),
        scope: guestScope,
        name: 'guest-work',
        projectIds: [],
        sortKey: 'guest-work',
        version: 1,
      }
      host.projectSession!.upsertGroup(guestGroup)
      expect(await bridge.devExecute(commandFor('dev.group.list', guestScope))).toMatchObject({
        ok: true,
      })
      const guestPartition = partitionFiles(dataDir)
      expect(guestPartition.size).toBeGreaterThan(0)

      // A non-member selection is refused with its typed code; the guest
      // scope and its channel keep working.
      await expect(
        bridge.invoke('desktop_identity_select_workspace', {
          workspaceId: FOREIGN,
          credential: guest(),
        })
      ).rejects.toThrow('unauthorized:')
      expect(await bridge.invoke('desktop_identity_scope')).toEqual(guestScope)

      // A verified selection: the reply is the new scope, and the bridge
      // swallowed the re-handshake bootstrap (it never reaches the caller).
      const selected = (await bridge.invoke('desktop_identity_select_workspace', {
        workspaceId: WORKSPACE_A,
        credential: guest(),
      })) as { scope: Scope; kind: string }
      expect(selected.kind).toBe('device')
      expect(selected).not.toHaveProperty('rehandshake')
      expect(selected.scope).toEqual({ ...guestScope, workspaceId: WORKSPACE_A })

      // The bridge re-handshook under the new scope: the old scope is refused
      // at the gate, the new one is served from an empty partition.
      expect(await bridge.devExecute(commandFor('dev.group.list', guestScope))).toMatchObject({
        ok: false,
        error: { code: 'channel_unauthorized' },
      })
      expect(await bridge.devExecute(commandFor('dev.group.list', selected.scope))).toMatchObject({
        ok: true,
        value: { items: [] },
      })
      const deviceGroup: Group = { ...guestGroup, id: randomUUID(), scope: selected.scope }
      host.projectSession!.upsertGroup(deviceGroup)

      // A different partition file exists for the workspace scope, and the
      // guest partition is byte-for-byte untouched (never migrated, never
      // deleted, never rewritten).
      const afterSwitch = partitionFiles(dataDir)
      const added = [...afterSwitch.keys()].filter((name) => !guestPartition.has(name))
      expect(added.some((name) => name.endsWith('.sqlite3'))).toBe(true)
      for (const [name, before] of guestPartition) {
        expect(afterSwitch.get(name)).toEqual(before)
      }

      // Switching between workspaces keeps each partition separate.
      await bridge.invoke('desktop_identity_select_workspace', {
        workspaceId: WORKSPACE_B,
        credential: guest(),
      })
      const scopeB = { ...guestScope, workspaceId: WORKSPACE_B }
      expect(await bridge.devExecute(commandFor('dev.group.list', scopeB))).toMatchObject({
        ok: true,
        value: { items: [] },
      })
      await bridge.invoke('desktop_identity_select_workspace', {
        workspaceId: WORKSPACE_A,
        credential: guest(),
      })
      expect(await bridge.devExecute(commandFor('dev.group.list', selected.scope))).toMatchObject({
        ok: true,
        value: { items: [deviceGroup] },
      })
      for (const [name, before] of guestPartition) {
        expect(partitionFiles(dataDir).get(name)).toEqual(before)
      }
    } finally {
      server.stop(true)
    }
  })

  test('a channel minted before the switch is revoked even without the bridge', async () => {
    const dataDir = tempDir()
    const cloud = scriptedCloud({ [TEMPORARY]: [WORKSPACE_A] })
    const identity = createDesktopIdentityAuthority({ dataDir, verifier: cloud.verifier })
    const authority = createChannelAuthority({
      shellHost: '127.0.0.1:4789',
      shellOrigin: 'http://127.0.0.1:4789',
    })
    identity.onBindingChanged(() => authority.revokeAllChannels())
    const issued = createIdentityCommandSurface({
      identity,
      issueRehandshake: () => authority.issueLaunchBootstrap(),
    })
    const open = () =>
      authority.handshake(
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
    const before = open()
    if (!before.ok) throw new Error('handshake failed')
    const reply = await issued.invoke('desktop_identity_select_workspace', {
      workspaceId: WORKSPACE_A,
      credential: guest(),
    })
    expect(reply).toMatchObject({ ok: true, rehandshake: expect.any(String) })
    // The revoked channel no longer authenticates anything.
    expect(() =>
      authority.authenticateLegacyRequest({
        headers: {
          'x-adea-channel': before.channelId,
          'x-adea-credential': before.clientCredentialId,
          'x-adea-nonce': randomBytes(24).toString('base64url'),
          'x-adea-timestamp': String(Date.now()),
          'x-adea-proof': 'x',
        },
        body: '{}',
      })
    ).toThrow('unknown channel credential')
    // A refusal carries the typed code and no re-handshake capability.
    const refused = await issued.invoke('desktop_identity_select_workspace', {
      workspaceId: FOREIGN,
      credential: guest(),
    })
    expect(refused).toEqual({
      ok: false,
      error: expect.stringMatching(/^unauthorized: /),
    })
    // Re-selecting the active workspace changes nothing and mints nothing.
    const again = await issued.invoke('desktop_identity_select_workspace', {
      workspaceId: WORKSPACE_A,
      credential: guest(),
    })
    expect(again).not.toHaveProperty('rehandshake')
  })
})
