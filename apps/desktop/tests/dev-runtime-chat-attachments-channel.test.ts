import { describe, expect, test } from 'bun:test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeDevReply,
  devCommandProofMessage,
  devOperationDefinitions,
  type ChatAttachment,
  type DevCommand,
  type DevOperation,
  type RuntimeSession,
  type Scope,
} from '../../../packages/types/src/dev-runtime'
import { registerChatAttachmentRuntime } from '../shell/src/dev-runtime/attachments/register'
import {
  ChannelRejection,
  createChannelAuthority,
  INTERNAL_DISPATCH_MARKER,
} from '../shell/src/dev-runtime/channel/authority'
import { createSessionEventLog } from '../shell/src/dev-runtime/harness/events'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const payload = {
  name: 'private-note.txt',
  mediaType: 'text/plain',
  contentBase64: Buffer.from('private attachment body').toString('base64'),
}
async function fixture(run: (context: Awaited<ReturnType<typeof boot>>) => Promise<void>) {
  const ctx = await boot()
  try {
    await run(ctx)
  } finally {
    rmSync(ctx.dataDir, { recursive: true, force: true })
  }
}
async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-1392-channel-'))
  const secret = randomBytes(32)
  let session: RuntimeSession = {
    id: 'session-1',
    scope,
    projectId: 'project-1',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    lifecycle: 'ready',
    archived: false,
    projection: 'structured',
    generation: 1,
    version: 1,
  }
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1:4789',
    shellOrigin: 'http://127.0.0.1:4789',
    authorizeCommand: (command) => {
      if (JSON.stringify(command.scope) !== JSON.stringify(scope))
        throw new ChannelRejection('channel_unauthorized', 'scope refused', 403)
    },
  })
  const events = createSessionEventLog({ dataDir, scope })
  registerChatAttachmentRuntime({
    authority,
    dataDir,
    scope,
    events,
    resolveSession: (id) => (id === session.id ? session : undefined),
    readKey: () => secret,
  })
  const handshake = authority.handshake(
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
  if (!handshake.ok) throw new Error('handshake failed')
  const channelSecret = Buffer.from(handshake.clientSecret, 'base64url')
  function buildCommand(
    operation: DevOperation,
    body: Record<string, unknown>,
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
      capabilities: [...devOperationDefinitions[operation].capabilities],
      resource: { kind: 'runtime_session', id: session.id, generation: session.generation },
      body: { runtimeSessionId: session.id, expectedGeneration: session.generation, ...body },
      ...overrides,
    }
  }
  function frame(command: DevCommand) {
    return {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
      command,
      proof: createHmac('sha256', channelSecret)
        .update(
          devCommandProofMessage({
            channelId: handshake.channelId,
            clientCredentialId: handshake.clientCredentialId,
            command,
          })
        )
        .digest('base64url'),
    }
  }
  async function execute(command: DevCommand) {
    return authority.execute(frame(command), { trusted: true })
  }
  return {
    dataDir,
    events,
    authority,
    command: buildCommand,
    frame,
    execute,
    update: (patch: Partial<RuntimeSession>) => {
      session = { ...session, ...patch }
    },
  }
}

describe('authorized local attachment operations', () => {
  test('signed upload/open/remove crosses the real gate and replies decode strictly without egress', () =>
    fixture(async (ctx) => {
      const previous = globalThis.fetch
      globalThis.fetch = (() => {
        throw new Error('unexpected external upload')
      }) as unknown as typeof fetch
      try {
        const reply = await ctx.execute(
          ctx.command(
            'dev.session.attachmentUpload',
            { upload: payload },
            { idempotencyKey: 'upload-1' }
          )
        )
        expect(reply.ok).toBe(true)
        expect(decodeDevReply(reply)).toEqual(reply)
        if (!reply.ok) throw new Error('upload failed')
        const attachment = reply.value as ChatAttachment
        const opened = await ctx.execute(
          ctx.command('dev.session.attachmentOpen', { attachmentId: attachment.attachmentId })
        )
        expect(opened.ok).toBe(true)
        expect(decodeDevReply(opened)).toEqual(opened)
        if (opened.ok)
          expect(opened.value).toMatchObject({
            contentBase64: payload.contentBase64,
            disposition: 'inert_text',
          })
        const removed = await ctx.execute(
          ctx.command('dev.session.attachmentRemove', { attachmentId: attachment.attachmentId })
        )
        expect(removed.ok).toBe(true)
        expect(decodeDevReply(removed)).toEqual(removed)
        const audit = JSON.stringify(ctx.authority.auditSnapshot())
        for (const privateValue of [payload.name, payload.contentBase64, 'private attachment body'])
          expect(audit).not.toContain(privateValue)
        expect(ctx.events.events().map((event) => event.kind)).toEqual([
          'attachment.added',
          'attachment.removed',
        ])
      } finally {
        globalThis.fetch = previous
      }
    }))

  test('wrong scope, capability, resource, signature, replay and revoked channels refuse before effects', () =>
    fixture(async (ctx) => {
      const valid = ctx.command(
        'dev.session.attachmentUpload',
        { upload: payload },
        { idempotencyKey: 'upload-1' }
      )
      const wrongScope = await ctx.execute({
        ...valid,
        scope: { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' },
      })
      expect(wrongScope.ok).toBe(false)
      expect((await ctx.execute({ ...valid, capabilities: ['dev.session.read'] })).ok).toBe(false)
      expect(
        (
          await ctx.execute({
            ...valid,
            resource: { kind: 'runtime_session', id: 'foreign-session', generation: 1 },
          })
        ).ok
      ).toBe(false)
      expect(
        (
          await ctx.authority.execute(
            { ...ctx.frame(valid), proof: randomBytes(32).toString('base64url') },
            { trusted: true }
          )
        ).ok
      ).toBe(false)
      expect(ctx.events.events()).toHaveLength(0)
      const first = ctx.frame(
        ctx.command(
          'dev.session.attachmentUpload',
          { upload: payload },
          { idempotencyKey: 'upload-1' }
        )
      )
      expect((await ctx.authority.execute(first, { trusted: true })).ok).toBe(true)
      expect((await ctx.authority.execute(first, { trusted: true })).ok).toBe(false)
      ctx.authority.revokeAllChannels()
      expect(
        (
          await ctx.execute(
            ctx.command(
              'dev.session.attachmentUpload',
              { upload: payload },
              { idempotencyKey: 'upload-2' }
            )
          )
        ).ok
      ).toBe(false)
      expect(ctx.events.events()).toHaveLength(1)
    }))

  test('stale generation, missing idempotency, archived upload and unsupported formats return typed refusals', () =>
    fixture(async (ctx) => {
      const old = ctx.command(
        'dev.session.attachmentUpload',
        { upload: payload },
        { idempotencyKey: 'upload-1' }
      )
      ctx.update({ generation: 2 })
      const stale = await ctx.execute(old)
      expect(stale.ok).toBe(false)
      if (!stale.ok) expect(stale.error.code).toBe('stale_generation')
      expect(
        (await ctx.execute(ctx.command('dev.session.attachmentUpload', { upload: payload }))).ok
      ).toBe(false)
      const unsupported = await ctx.execute(
        ctx.command(
          'dev.session.attachmentUpload',
          { upload: { ...payload, name: 'image.png', mediaType: 'image/png' } },
          { idempotencyKey: 'unsupported' }
        )
      )
      expect(unsupported.ok).toBe(false)
      if (!unsupported.ok) expect(unsupported.error.code).toBe('unsupported_capability')
      ctx.update({ archived: true })
      expect(
        (
          await ctx.execute(
            ctx.command(
              'dev.session.attachmentUpload',
              { upload: payload },
              { idempotencyKey: 'archived' }
            )
          )
        ).ok
      ).toBe(false)
      expect(ctx.events.events()).toHaveLength(0)
    }))

  test('maximum supported content fits the existing authenticated control envelope', () =>
    fixture(async (ctx) => {
      const reply = await ctx.execute(
        ctx.command(
          'dev.session.attachmentUpload',
          {
            upload: { ...payload, contentBase64: Buffer.alloc(128 * 1024, 120).toString('base64') },
          },
          { idempotencyKey: 'maximum' }
        )
      )
      expect(reply.ok).toBe(true)
      expect(decodeDevReply(reply)).toEqual(reply)
    }))

  test('the in-process path uses the same provider without manufacturing a transport identity', () =>
    fixture(async (ctx) => {
      const reply = await ctx.authority.dispatchLocal(
        INTERNAL_DISPATCH_MARKER,
        ctx.command(
          'dev.session.attachmentUpload',
          { upload: payload },
          { idempotencyKey: 'local' }
        )
      )
      expect(reply.ok).toBe(true)
      expect(
        ctx.authority
          .auditSnapshot()
          .filter((entry) => entry.kind === 'command_accepted')
          .at(-1)?.channelId
      ).toBeUndefined()
    }))
})
