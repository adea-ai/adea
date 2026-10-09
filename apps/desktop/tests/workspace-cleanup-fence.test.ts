import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createChannelAuthority,
  INTERNAL_DISPATCH_MARKER,
} from '../shell/src/dev-runtime/channel/authority'
import { createCloudIdentityVerifier } from '../shell/src/dev-runtime/channel/identity'
import { createCommandSurface } from '../shell/src/commands'
import { devOperationDefinitions, type DevCommand } from '../../../packages/types/src/dev-runtime'
const scope = { accountId: randomUUID(), workspaceId: randomUUID(), runtimeNodeId: randomUUID() }
function command(): DevCommand {
  return {
    schemaVersion: 1,
    operation: 'dev.project.list',
    scope,
    requestId: randomUUID(),
    nonce: randomUUID(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    capabilities: [...devOperationDefinitions['dev.project.list'].capabilities],
    body: {},
  }
}

test('accounting covers pending providers and resets after failure; the final fence closes an async admission race', async () => {
  let paused = false
  let unblock!: () => void
  let started!: () => void
  const start = new Promise<void>((resolve) => {
    started = resolve
  })
  const authority = createChannelAuthority({
    shellHost: '127.0.0.1',
    shellOrigin: 'http://127.0.0.1',
    authorizeCommand: async () => {},
    assertCommandAllowed: () => {
      if (paused) throw new Error('workspace_cleanup_pending')
    },
  })
  authority.registerCommandProvider('dev.project.list', async () => {
    started()
    await new Promise<void>((resolve) => {
      unblock = resolve
    })
    throw new Error('fixture provider failure')
  })
  const pending = authority.dispatchLocal(INTERNAL_DISPATCH_MARKER, command())
  await start
  expect(authority.inFlightCommands(scope)).toBe(1)
  unblock()
  await pending
  expect(authority.inFlightCommands(scope)).toBe(0)
  const racing = authority.dispatchLocal(INTERNAL_DISPATCH_MARKER, command())
  paused = true
  const result = await racing
  expect(result.ok).toBe(false)
  expect(authority.inFlightCommands(scope)).toBe(0)
})

test('legacy read/update/delete cannot disguise the stored owner to bypass a deletion fence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adea-content-fence-'))
  let paused = false
  try {
    const invoke = createCommandSurface(dir, {
      assertWorkspaceActive: (id) => {
        if (paused && id === scope.workspaceId) throw new Error('workspace_cleanup_pending')
      },
    })
    const created = invoke('local_content_create', {
      input: {
        workspaceId: scope.workspaceId,
        plaintext: 'private fixture content',
        contentType: 'private_field',
      },
    }) as { ok: true; value: { id: string } }
    expect(created.ok).toBe(true)
    paused = true
    for (const name of ['read', 'update', 'delete'])
      expect(
        invoke(`local_content_${name}`, {
          input: {
            workspaceId: randomUUID(),
            contentId: created.value.id,
            plaintext: 'must not replace',
          },
        })
      ).toEqual({ ok: false, error: 'workspace_cleanup_pending' })
    paused = false
    expect(invoke('local_content_read', { input: { contentId: created.value.id } })).toMatchObject({
      ok: true,
      value: { plaintext: 'private fixture content' },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cloud owner receipt proof requires the exact workspace and never accepts a malformed or unavailable response', async () => {
  let body: unknown = { workspaceId: scope.workspaceId, state: 'deleted' }
  let status = 200
  const urls: string[] = []
  const verifier = createCloudIdentityVerifier({
    cloudOrigin: 'https://fixture.invalid',
    shellOrigin: 'http://127.0.0.1',
    fetchImpl: async (url) => {
      urls.push(String(url))
      return Response.json(body, { status })
    },
  })
  const input = {
    workspaceId: scope.workspaceId,
    credential: { kind: 'temporary' as const, credential: `adea_tmp_${'g'.repeat(43)}` },
  }
  expect(await verifier.workspaceDeletionState!(input)).toBe('deleted')
  expect(urls).toEqual([`https://fixture.invalid/api/workspaces/${scope.workspaceId}/delete`])
  body = { workspaceId: randomUUID(), state: 'deleted' }
  await expect(verifier.workspaceDeletionState!(input)).rejects.toMatchObject({
    code: 'corrupt_state',
  })
  status = 404
  await expect(verifier.workspaceDeletionState!(input)).rejects.toThrow()
})
