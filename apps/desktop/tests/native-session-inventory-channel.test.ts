import { describe, expect, test } from 'bun:test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDecoders,
  type DevCommand,
  type DevReply,
  type DevRuntimePage,
  type Project,
  type RuntimeSession,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import {
  ChannelRejection,
  createChannelAuthority,
  type ChannelAuthority,
} from '../shell/src/dev-runtime/channel/authority'
import { registerProjectSessionRuntime } from '../shell/src/dev-runtime/project-session/register'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const project: Project = {
  id: '00000000-0000-4000-8000-000000000020',
  scope,
  repoIds: ['00000000-0000-4000-8000-000000000030'],
  lifecycle: 'ready',
  version: 1,
}
const session: RuntimeSession = {
  id: '00000000-0000-4000-8000-000000000040',
  scope,
  projectId: project.id,
  repoId: project.repoIds[0]!,
  worktreeId: '00000000-0000-4000-8000-000000000050',
  displayName: 'Synthetic inventory row',
  lifecycle: 'completed',
  archived: false,
  projection: 'structured',
  generation: 1,
  version: 1,
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-inventory-channel-'))
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'https://127.0.0.1:4789',
    authorizeCommand(command) {
      if (
        command.scope.accountId !== scope.accountId ||
        command.scope.workspaceId !== scope.workspaceId ||
        command.scope.runtimeNodeId !== scope.runtimeNodeId
      ) {
        throw new ChannelRejection('channel_unauthenticated', 'scope mismatch', 403)
      }
    },
  })
  const runtime = registerProjectSessionRuntime({ authority, dataDir, scope })
  runtime.upsertProject(project)
  const list = runtime.providers['dev.session.list']
  if (!list) throw new Error('inventory provider missing')
  let providerCalls = 0
  authority.registerCommandProvider('dev.session.list', (command) => {
    providerCalls += 1
    return list(command)
  })
  return {
    authority,
    runtime,
    providerCalls: () => providerCalls,
    dispose: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

function handshake(authority: ChannelAuthority) {
  const at = Date.now()
  const reply = authority.handshake(
    {
      schemaVersion: 1,
      method: 'dev.runtime.handshake.v1',
      requestId: randomUUID(),
      bootstrap: authority.issueLaunchBootstrap(),
      supportedProtocolVersions: ['1'],
      nonce: randomBytes(16).toString('base64url'),
      issuedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + 30_000).toISOString(),
    },
    { trusted: true }
  )
  if (!reply.ok) throw new Error('inventory handshake refused')
  return reply
}

function signedList(
  identity: ReturnType<typeof handshake>,
  body: Readonly<Record<string, unknown>>,
  commandScope: Scope = scope
) {
  const at = Date.now()
  const command: DevCommand = {
    schemaVersion: 1,
    operation: 'dev.session.list',
    requestId: randomUUID(),
    nonce: randomBytes(16).toString('base64url'),
    issuedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 30_000).toISOString(),
    scope: commandScope,
    capabilities: ['dev.session.read'],
    body,
  }
  const frame = {
    channelId: identity.channelId,
    clientCredentialId: identity.clientCredentialId,
    command,
  }
  return {
    ...frame,
    proof: createHmac('sha256', Buffer.from(identity.clientSecret, 'base64url'))
      .update(devCommandProofMessage(frame), 'utf8')
      .digest('base64url'),
  }
}

function page(reply: DevReply) {
  if (!reply.ok) throw new Error(`inventory refused: ${reply.error.code}`)
  expect(reply.operation).toBe('dev.session.list')
  const decoded = devOperationDecoders['dev.session.list'].reply(reply)
  if (!decoded.ok) throw new Error('expected a decoded inventory page')
  return decoded.value as DevRuntimePage<RuntimeSession>
}

function expectRefused(reply: DevReply, code: string) {
  if (reply.ok) throw new Error('expected inventory refusal')
  expect(reply.error.code).toBe(code)
}

describe('signed native session inventory with the SQLite register', () => {
  test('walks more than 500 filtered rows through real handshake and HMAC frames', async () => {
    const world = fixture()
    try {
      const ids = Array.from(
        { length: 621 },
        (_, index) => `00000000-0000-4000-8000-${(index + 256).toString(16).padStart(12, '0')}`
      )
      // Only synthetic register writes: no create/resume command, PTY or harness.
      for (const id of ids.toReversed()) world.runtime.upsertSession({ ...session, id })
      world.runtime.upsertSession({ ...session, archived: true })
      const identity = handshake(world.authority)
      const filters = {
        archived: false,
        projectId: project.id,
        worktreeId: session.worktreeId,
        limit: 500,
      }
      const first = page(
        await world.authority.execute(signedList(identity, filters), { trusted: true })
      )
      expect(first.items.map(({ id }) => id)).toEqual(ids.slice(0, 500))
      expect(first.nextCursor).toBe(ids[499])
      const final = page(
        await world.authority.execute(
          signedList(identity, { ...filters, cursor: first.nextCursor }),
          { trusted: true }
        )
      )
      expect(final.items.map(({ id }) => id)).toEqual(ids.slice(500))
      expect(final.nextCursor).toBeUndefined()
      const captured = [...first.items, ...final.items]
      expect(captured.map(({ id }) => id)).toEqual(ids)
      expect(new Set(captured.map(({ id }) => id)).size).toBe(621)
      expect(captured.every((row) => !row.archived && row.lifecycle === 'completed')).toBe(true)
      for (const row of captured) expect(row.scope).toEqual(scope)
      expect(world.providerCalls()).toBe(2)
      expect(world.authority.countersSnapshot().commandsAccepted).toBe(2)
      expect(
        world.authority.auditSnapshot().filter((record) => record.kind === 'command_accepted')
      ).toHaveLength(2)
      expect(world.runtime.getSession(session.id)?.archived).toBe(true)
      expect(world.runtime.archiveRecords()).toEqual([])
    } finally {
      world.dispose()
    }
  }, 60_000)

  test('refuses scope, proof, replay, and revocation violations before dispatch', async () => {
    const world = fixture()
    try {
      world.runtime.upsertSession(session)
      const identity = handshake(world.authority)
      for (const key of ['accountId', 'workspaceId', 'runtimeNodeId'] as const) {
        expectRefused(
          await world.authority.execute(
            signedList(identity, {}, { ...scope, [key]: randomUUID() }),
            { trusted: true }
          ),
          'channel_unauthenticated'
        )
        expect(world.providerCalls()).toBe(0)
      }
      const tampered = signedList(identity, { limit: 1 })
      tampered.command = { ...tampered.command, body: { limit: 2 } }
      expectRefused(await world.authority.execute(tampered, { trusted: true }), 'identity_mismatch')
      expect(world.providerCalls()).toBe(0)
      const accepted = signedList(identity, { limit: 1 })
      expect(page(await world.authority.execute(accepted, { trusted: true })).items).toEqual([
        session,
      ])
      expect(world.providerCalls()).toBe(1)
      expectRefused(await world.authority.execute(accepted, { trusted: true }), 'replay_rejected')
      expect(world.providerCalls()).toBe(1)
      const pending = signedList(identity, {})
      expect(world.authority.revokeAllChannels()).toBe(1)
      expectRefused(
        await world.authority.execute(pending, { trusted: true }),
        'channel_unauthenticated'
      )
      expect(world.providerCalls()).toBe(1)
      const renewed = handshake(world.authority)
      expect(renewed.channelId).not.toBe(identity.channelId)
      expect(
        page(await world.authority.execute(signedList(renewed, {}), { trusted: true })).items
      ).toEqual([session])
      expect(world.providerCalls()).toBe(2)
      expect(world.runtime.getSession(session.id)).toEqual(session)
      expect(world.runtime.archiveRecords()).toEqual([])
    } finally {
      world.dispose()
    }
  })

  test('refuses malformed page bodies before provider dispatch', async () => {
    const world = fixture()
    try {
      world.runtime.upsertSession(session)
      const identity = handshake(world.authority)
      for (const body of [
        { limit: 0 },
        { limit: 501 },
        { limit: 1.5 },
        { limit: '2' },
        { cursor: 1 },
        { runtimeSessionId: session.id },
      ]) {
        expectRefused(
          await world.authority.execute(signedList(identity, body), { trusted: true }),
          'invalid_state'
        )
        expect(world.providerCalls()).toBe(0)
      }
      expect(
        page(await world.authority.execute(signedList(identity, {}), { trusted: true })).items
      ).toEqual([session])
      expect(world.providerCalls()).toBe(1)
    } finally {
      world.dispose()
    }
  })

  test('refuses invalid cursor bounds in the provider without session mutations', async () => {
    const world = fixture()
    try {
      world.runtime.upsertSession(session)
      const identity = handshake(world.authority)
      let expectedCalls = 0
      // The registry admits strings; the provider owns the nonempty/512 bound.
      for (const cursor of ['', 'x'.repeat(513)]) {
        expectRefused(
          await world.authority.execute(signedList(identity, { cursor }), { trusted: true }),
          'invalid_state'
        )
        expectedCalls += 1
        expect(world.providerCalls()).toBe(expectedCalls)
        expect(world.runtime.getSession(session.id)).toEqual(session)
      }
      expect(world.authority.countersSnapshot().commandsAccepted).toBe(0)
      expect(world.runtime.archiveRecords()).toEqual([])
    } finally {
      world.dispose()
    }
  })
})
