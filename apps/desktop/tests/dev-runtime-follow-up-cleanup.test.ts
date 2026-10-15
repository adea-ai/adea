import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFollowUpQueue } from '../shell/src/dev-runtime/harness/follow-ups'
import { createMemoryStore } from '../shell/src/memory/store'
import { workspaceLocalData } from '../shell/src/workspace-local-data'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-follow-up-cleanup-'))
  const key = Buffer.alloc(32, 5)
  mkdirSync(join(dataDir, 'desktop-state'))
  const keyFile = join(dataDir, 'desktop-state', 'device.key')
  writeFileSync(keyFile, key, { mode: 0o600 })
  const memory = createMemoryStore({ contentDir: join(dataDir, 'local-content'), key: () => key })
  const queue = (workspaceId: string) =>
    createFollowUpQueue({
      dataDir,
      scope: { ...scope, workspaceId },
      resolve: () => ({
        generation: 1,
        archived: false,
        runId: 'run-1',
        runVersion: 1,
        state: 'working',
        deliverySupported: false,
      }),
      publish: () => {},
    })
  const authorization = { idempotencyKey: 'enqueue', authorize: async () => () => {} }
  const request = {
    runtimeSessionId: 'session-1',
    expectedGeneration: 1,
    expectedVersion: 0,
    action: 'enqueue' as const,
    messageId: 'message-1',
    text: 'private queued text',
  }
  return {
    dataDir,
    key,
    keyFile,
    memory,
    queue,
    authorization,
    request,
    cleanup: workspaceLocalData({ dataDir, scope, memory }),
    remove: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}
describe('workspace-owned follow-up queue cleanup', () => {
  test('retained recovery artifacts block purge even after the original queue file was quarantined', async () => {
    const s = fixture()
    try {
      const own = s.queue(scope.workspaceId)
      await own.execute(s.request, s.authorization)
      s.memory.create(scope.workspaceId, { text: 'retain pending recovery' })
      writeFileSync(own.storageFile, '{invalid-json')
      await expect(
        own.execute(
          { runtimeSessionId: 'session-1', expectedGeneration: 1, action: 'read' },
          s.authorization
        )
      ).rejects.toMatchObject({ code: 'corrupt_state' })
      expect(() => s.cleanup.purge()).toThrow('workspace_cleanup_follow_up_data_pending')
      expect(s.memory.list(scope.workspaceId).entries).toHaveLength(1)
    } finally {
      s.remove()
    }
  })

  test('purges only the authenticated workspace queue and preserves sibling queues and the existing key', async () => {
    const s = fixture()
    try {
      const own = s.queue(scope.workspaceId)
      const sibling = s.queue('00000000-0000-4000-8000-000000000099')
      await own.execute(s.request, s.authorization)
      await sibling.execute(s.request, s.authorization)
      s.cleanup.purge()
      expect(existsSync(own.storageFile)).toBe(false)
      expect(existsSync(sibling.storageFile)).toBe(true)
      expect(readFileSync(s.keyFile)).toEqual(s.key)
      expect(
        (
          await sibling.execute(
            { runtimeSessionId: 'session-1', expectedGeneration: 1, action: 'read' },
            s.authorization
          )
        ).items[0]?.text
      ).toBe('private queued text')
    } finally {
      s.remove()
    }
  })
  test('refuses unreadable queue ciphertext before any workspace data is deleted', async () => {
    const s = fixture()
    try {
      const own = s.queue(scope.workspaceId)
      await own.execute(s.request, s.authorization)
      s.memory.create(scope.workspaceId, { text: 'retain this memory' })
      const stored = JSON.parse(readFileSync(own.storageFile, 'utf8'))
      stored.records[0].ciphertext = 'corrupted'
      const original = JSON.stringify(stored)
      writeFileSync(own.storageFile, original)
      expect(() => s.cleanup.purge()).toThrow('workspace_cleanup_follow_up_data_pending')
      expect(readFileSync(own.storageFile, 'utf8')).toBe(original)
      expect(s.memory.list(scope.workspaceId).entries).toHaveLength(1)
      expect(readFileSync(s.keyFile)).toEqual(s.key)
    } finally {
      s.remove()
    }
  })
})
