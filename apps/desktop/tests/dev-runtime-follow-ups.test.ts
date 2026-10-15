import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FollowUpQueueRequest } from '../../../packages/types/src/dev-runtime-follow-ups'
import {
  createFollowUpQueue,
  type FollowUpLiveState,
} from '../shell/src/dev-runtime/harness/follow-ups'

const scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adea-follow-ups-'))
  let live: FollowUpLiveState = {
    generation: 1,
    runId: 'run-1',
    runVersion: 1,
    state: 'working',
    archived: false,
    deliverySupported: true,
  }
  let revoked = false
  let keys = 0
  const delivered: string[] = []
  const events: unknown[] = []
  let handoff: (text: string) => Promise<{ ok: boolean }> = async (text) => {
    delivered.push(text)
    return { ok: true }
  }
  const options = {
    dataDir,
    scope,
    key: () => Buffer.alloc(32, 7),
    resolve: () => live,
    publish: (event: unknown) => {
      events.push(event)
    },
    deliver: async (input: { text: string }) => handoff(input.text),
    deliveryTimeoutMs: 30,
  }
  const queue = createFollowUpQueue(options)
  const authorize = async () => () => {
    if (revoked) throw { code: 'channel_unauthorized', retryable: false, message: 'revoked' }
  }
  const target = { runtimeSessionId: 'session-1', expectedGeneration: 1 }
  const execute = (request: FollowUpQueueRequest, key = `request-${++keys}`) =>
    queue.execute(request, { idempotencyKey: key, authorize })
  const read = () => execute({ ...target, action: 'read' })
  const enqueue = async (messageId: string, text = messageId) =>
    execute({
      ...target,
      action: 'enqueue',
      expectedVersion: (await read()).version,
      messageId,
      text,
    })
  return {
    queue,
    options,
    target,
    execute,
    read,
    enqueue,
    dataDir,
    delivered,
    events,
    authorize,
    setLive: (patch: Partial<FollowUpLiveState>) => {
      live = { ...live, ...patch }
    },
    revoke: () => {
      revoked = true
    },
    setHandoff: (value: typeof handoff) => {
      handoff = value
    },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

describe('authorized follow-up queue', () => {
  test('restart recovers a durable claim after publication failed before any send, allowing explicit removal', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      s.setLive({ state: 'awaiting_input', runVersion: 2 })
      const publish = s.options.publish
      s.options.publish = () => {
        throw new Error('publication interrupted')
      }
      const request = { ...s.target, action: 'deliver' as const, expectedVersion: 1 }
      await expect(s.execute(request, 'send')).rejects.toThrow('publication interrupted')
      expect(s.delivered).toEqual([])
      s.options.publish = publish
      const restarted = createFollowUpQueue(s.options)
      const recovered = await restarted.execute(
        { ...s.target, action: 'read' },
        { authorize: s.authorize }
      )
      expect(recovered.items[0]?.state).toBe('ambiguous')
      expect(recovered.lastDelivery).toEqual({ messageId: 'a', status: 'ambiguous' })
      expect(
        (await restarted.execute(request, { idempotencyKey: 'send', authorize: s.authorize }))
          .version
      ).toBe(recovered.version)
      await expect(
        restarted.execute(
          { ...s.target, action: 'deliver', expectedVersion: recovered.version },
          {
            idempotencyKey: 'new-send',
            authorize: s.authorize,
          }
        )
      ).rejects.toMatchObject({ code: 'delivery_ambiguous' })
      const removed = await restarted.execute(
        { ...s.target, action: 'remove', expectedVersion: recovered.version, messageId: 'a' },
        {
          idempotencyKey: 'remove',
          authorize: s.authorize,
        }
      )
      expect(removed.items).toEqual([])
      await expect(s.enqueue('a')).rejects.toMatchObject({ code: 'idempotency_conflict' })
      expect(s.delivered).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('a peer cannot recover or remove an active claim merely because its heartbeat is old', async () => {
    const s = setup()
    try {
      s.options.deliveryTimeoutMs = 2_000
      await s.enqueue('a')
      s.setLive({ state: 'awaiting_input', runVersion: 2 })
      let entered!: () => void
      let finish!: (result: { ok: boolean }) => void
      const began = new Promise<void>((resolve) => {
        entered = resolve
      })
      s.setHandoff(async (text) => {
        s.delivered.push(text)
        entered()
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const pending = s.execute({ ...s.target, action: 'deliver', expectedVersion: 1 })
      await began
      const lockDir = join(s.dataDir, 'dev-runtime', 'worktrees', 'locks')
      let aged = 0
      for (const name of readdirSync(lockDir)) {
        const file = join(lockDir, name)
        const record = JSON.parse(readFileSync(file, 'utf8'))
        if (record.operation === 'follow-up delivery') {
          aged += 1
          writeFileSync(
            file,
            JSON.stringify({ ...record, heartbeatAt: '1970-01-01T00:00:00.000Z' })
          )
        }
      }
      expect(aged).toBe(1)
      const peer = createFollowUpQueue(s.options)
      const active = await peer.execute({ ...s.target, action: 'read' }, { authorize: s.authorize })
      expect(active.items[0]?.state).toBe('dispatching')
      await expect(
        peer.execute(
          { ...s.target, action: 'remove', expectedVersion: active.version, messageId: 'a' },
          {
            idempotencyKey: 'peer-remove',
            authorize: s.authorize,
          }
        )
      ).rejects.toMatchObject({ code: 'invalid_state' })
      finish({ ok: true })
      expect((await pending).lastDelivery).toEqual({ messageId: 'a', status: 'accepted' })
      expect(s.delivered).toEqual(['a'])
    } finally {
      s.cleanup()
    }
  })

  test('a restarted host recovers a claim left by a dead process before handoff without sending it', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      s.setLive({ state: 'awaiting_input', runVersion: 2 })
      const module = new URL('../shell/src/dev-runtime/harness/follow-ups.ts', import.meta.url).href
      const marker = join(s.dataDir, 'unexpected-send')
      const script = `import { createFollowUpQueue } from ${JSON.stringify(module)};
        import { writeFileSync } from 'node:fs';
        const queue = createFollowUpQueue({
          dataDir: ${JSON.stringify(s.dataDir)}, scope: ${JSON.stringify(scope)}, key: () => Buffer.alloc(32, 7),
          resolve: () => ({ generation: 1, archived: false, runId: 'run-1', runVersion: 2, state: 'awaiting_input', deliverySupported: true }),
          publish: (event) => { if (event.change === 'delivery_started') process.exit(0) },
          deliver: async () => { writeFileSync(${JSON.stringify(marker)}, 'sent'); return { ok: true } },
        });
        await queue.execute({ runtimeSessionId: 'session-1', expectedGeneration: 1, action: 'deliver', expectedVersion: 1 }, {
          idempotencyKey: 'child-send', authorize: async () => () => {},
        });
        process.exit(1);`
      const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
      expect(await child.exited).toBe(0)
      expect(existsSync(marker)).toBe(false)
      const restarted = createFollowUpQueue(s.options)
      const lockDir = join(s.dataDir, 'dev-runtime', 'worktrees', 'locks')
      const claimFile = readdirSync(lockDir)
        .map((name) => join(lockDir, name))
        .find((file) => JSON.parse(readFileSync(file, 'utf8')).operation === 'follow-up delivery')!
      const owner = JSON.parse(readFileSync(claimFile, 'utf8'))
      const { pid: _pid, ...unknownOwner } = owner
      writeFileSync(claimFile, JSON.stringify(unknownOwner))
      const blocked = await restarted.execute(
        { ...s.target, action: 'read' },
        { authorize: s.authorize }
      )
      expect(blocked.items[0]?.state).toBe('dispatching')
      await expect(
        restarted.execute(
          { ...s.target, action: 'remove', expectedVersion: blocked.version, messageId: 'a' },
          {
            idempotencyKey: 'unknown-owner-remove',
            authorize: s.authorize,
          }
        )
      ).rejects.toMatchObject({ code: 'invalid_state' })
      // Restore only this test's original owner evidence: the proven-dead
      // child can then be reclaimed. No production recovery edits the file.
      writeFileSync(claimFile, JSON.stringify(owner))
      const recovered = await restarted.execute(
        { ...s.target, action: 'read' },
        { authorize: s.authorize }
      )
      expect(recovered.items[0]?.state).toBe('ambiguous')
      expect(recovered.lastDelivery).toEqual({ messageId: 'a', status: 'ambiguous' })
      expect(
        (
          await restarted.execute(
            { ...s.target, action: 'remove', expectedVersion: recovered.version, messageId: 'a' },
            {
              idempotencyKey: 'remove-after-restart',
              authorize: s.authorize,
            }
          )
        ).items
      ).toEqual([])
      expect(existsSync(marker)).toBe(false)
      expect(s.delivered).toEqual([])
    } finally {
      s.cleanup()
    }
  }, 10_000)

  test('retained corrupt storage remains a recovery barrier instead of resetting delivery tombstones', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      writeFileSync(s.queue.storageFile, '{invalid-json')
      await expect(s.read()).rejects.toMatchObject({ code: 'corrupt_state' })
      await expect(s.read()).rejects.toMatchObject({ code: 'recovery_required' })
      expect(s.delivered).toEqual([])
      expect(s.events).toHaveLength(1)
    } finally {
      s.cleanup()
    }
  })

  test('does not hand off to a replaced structured connection after claiming the queue head', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      s.setLive({ state: 'awaiting_input', runVersion: 2, deliveryBinding: 'connection-1:1' })
      const publish = s.options.publish
      s.options.publish = (event) => {
        publish(event)
        if ((event as { change?: string }).change === 'delivery_started')
          s.setLive({ deliveryBinding: 'connection-2:1' })
      }
      await expect(
        s.execute({ ...s.target, action: 'deliver', expectedVersion: 1 })
      ).rejects.toMatchObject({ code: 'invalid_state' })
      expect(s.delivered).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('serializes independent host processes against the same bounded queue', async () => {
    const s = setup()
    try {
      const module = new URL('../shell/src/dev-runtime/harness/follow-ups.ts', import.meta.url).href
      const workers = ['child-a', 'child-b'].map((id) => {
        const script = `import { createFollowUpQueue } from ${JSON.stringify(module)};
          const queue = createFollowUpQueue({ dataDir: ${JSON.stringify(s.dataDir)}, scope: ${JSON.stringify(scope)}, key: () => Buffer.alloc(32, 7), resolve: () => ({ generation: 1, archived: false, runId: 'run-1', runVersion: 1, state: 'working', deliverySupported: false }), publish: () => {} });
          try { await queue.execute({ runtimeSessionId: 'session-1', expectedGeneration: 1, action: 'enqueue', expectedVersion: 0, messageId: ${JSON.stringify(id)}, text: ${JSON.stringify(id)} }, { idempotencyKey: ${JSON.stringify(id)}, authorize: async () => () => {} }); process.stdout.write('ok'); }
          catch (error) { process.stdout.write(error.code ?? 'unexpected_error'); }`
        return Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
      })
      const outcomes = await Promise.all(
        workers.map(async (worker) => {
          const output = await new Response(worker.stdout).text()
          expect(await worker.exited).toBe(0)
          return output
        })
      )
      expect(outcomes.toSorted()).toEqual(['ok', 'stale_version'])
      expect((await s.read()).items).toHaveLength(1)
    } finally {
      s.cleanup()
    }
  }, 10_000)

  test('authenticates sealed queue text to the exact scope and preserves unread ciphertext', async () => {
    const s = setup()
    try {
      await s.enqueue('a', 'private scope A text')
      const peer = createFollowUpQueue({
        ...s.options,
        scope: { ...scope, workspaceId: '00000000-0000-4000-8000-000000000099' },
      })
      const ciphertext = readFileSync(s.queue.storageFile, 'utf8')
      writeFileSync(peer.storageFile, ciphertext, { mode: 0o600 })
      await expect(
        peer.execute({ ...s.target, action: 'read' }, { authorize: s.authorize })
      ).rejects.toMatchObject({ code: 'corrupt_state' })
      expect(readFileSync(peer.storageFile, 'utf8')).toBe(ciphertext)
      expect((await s.read()).items[0]?.text).toBe('private scope A text')
    } finally {
      s.cleanup()
    }
  })

  test('rechecks generation after waiting to finalize an accepted handoff', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      s.setLive({ state: 'awaiting_input', runVersion: 2 })
      const resolve = s.options.resolve
      let scheduled = false
      s.options.resolve = () => {
        const current = resolve()
        if (s.delivered.length && !scheduled) {
          scheduled = true
          queueMicrotask(() => s.setLive({ generation: 2 }))
        }
        return current
      }
      await expect(
        s.execute({ ...s.target, action: 'deliver', expectedVersion: 1 })
      ).rejects.toMatchObject({ code: 'stale_generation' })
      expect(JSON.stringify(s.events)).not.toContain('delivery_accepted')
    } finally {
      s.cleanup()
    }
  })

  test('persists a generation fence so an older host instance cannot restore old queued messages', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      s.setLive({ generation: 2 })
      expect(
        (await s.execute({ runtimeSessionId: 'session-1', expectedGeneration: 2, action: 'read' }))
          .items
      ).toEqual([])
      const stale = createFollowUpQueue({
        ...s.options,
        resolve: () => ({
          generation: 1,
          runId: 'run-1',
          runVersion: 1,
          state: 'working' as const,
          archived: false,
          deliverySupported: true,
        }),
      })
      await expect(
        stale.execute({ ...s.target, action: 'read' }, { authorize: s.authorize })
      ).rejects.toMatchObject({ code: 'stale_generation' })
    } finally {
      s.cleanup()
    }
  })

  test('queues while busy, reorders/removes exactly, and never invokes Steer', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      await s.enqueue('b')
      expect(s.delivered).toEqual([])
      const reordered = await s.execute({
        ...s.target,
        action: 'reorder',
        expectedVersion: 2,
        messageIds: ['b', 'a'],
      })
      expect(reordered.items.map((item) => item.id)).toEqual(['b', 'a'])
      const removed = await s.execute({
        ...s.target,
        action: 'remove',
        expectedVersion: 3,
        messageId: 'a',
      })
      expect(removed.items.map((item) => item.id)).toEqual(['b'])
      expect(removed.delivery).toBe('busy')
      expect(JSON.stringify(s.events)).not.toContain('"text"')
    } finally {
      s.cleanup()
    }
  })

  test('replays idempotent changes and rejects conflicting keys, stale versions and stale generations', async () => {
    const s = setup()
    try {
      const request = {
        ...s.target,
        action: 'enqueue' as const,
        expectedVersion: 0,
        messageId: 'a',
        text: 'private prompt',
      }
      expect((await s.execute(request, 'same')).version).toBe(1)
      expect((await s.execute(request, 'same')).version).toBe(1)
      expect(s.events).toHaveLength(1)
      await expect(s.execute({ ...request, text: 'different' }, 'same')).rejects.toMatchObject({
        code: 'idempotency_conflict',
      })
      await expect(s.execute({ ...request, messageId: 'b' })).rejects.toMatchObject({
        code: 'stale_version',
      })
      s.setLive({ generation: 2 })
      await expect(s.execute(request, 'same')).rejects.toMatchObject({ code: 'stale_generation' })
      expect(
        (await s.execute({ runtimeSessionId: 'session-1', expectedGeneration: 2, action: 'read' }))
          .items
      ).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('concurrent writers cannot lose an update or duplicate a delivery', async () => {
    const s = setup()
    try {
      const peer = createFollowUpQueue(s.options)
      const a = {
        ...s.target,
        action: 'enqueue' as const,
        expectedVersion: 0,
        messageId: 'a',
        text: 'a',
      }
      const results = await Promise.allSettled([
        s.execute(a, 'a'),
        peer.execute({ ...a, messageId: 'b' }, { idempotencyKey: 'b', authorize: s.authorize }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect((await s.read()).items).toHaveLength(1)
      s.setLive({ state: 'awaiting_input', runVersion: 2 })
      const request = { ...s.target, action: 'deliver' as const, expectedVersion: 1 }
      const sends = await Promise.allSettled([
        s.execute(request, 'send'),
        peer.execute(request, { idempotencyKey: 'send', authorize: s.authorize }),
      ])
      expect(sends.some((result) => result.status === 'fulfilled')).toBe(true)
      expect(s.delivered).toHaveLength(1)
      await s.execute(request, 'send')
      expect(s.delivered).toHaveLength(1)
    } finally {
      s.cleanup()
    }
  })

  test('requires a fresh observed idle boundary and real structured delivery', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      await s.enqueue('b')
      await expect(
        s.execute({ ...s.target, action: 'deliver', expectedVersion: 2 })
      ).rejects.toMatchObject({ code: 'invalid_state' })
      s.setLive({ state: 'awaiting_input', runVersion: 2, deliverySupported: false })
      expect((await s.read()).delivery).toBe('unavailable')
      await expect(
        s.execute({ ...s.target, action: 'deliver', expectedVersion: 2 })
      ).rejects.toMatchObject({ code: 'capability_unavailable' })
      s.setLive({ deliverySupported: true })
      const first = await s.execute({ ...s.target, action: 'deliver', expectedVersion: 2 })
      expect(first.lastDelivery).toEqual({ messageId: 'a', status: 'accepted' })
      await expect(
        s.execute({ ...s.target, action: 'deliver', expectedVersion: first.version })
      ).rejects.toMatchObject({ code: 'invalid_state' })
      s.setLive({ runVersion: 4 })
      await s.execute({ ...s.target, action: 'deliver', expectedVersion: first.version })
      expect(s.delivered).toEqual(['a', 'b'])
    } finally {
      s.cleanup()
    }
  })

  test('Stop invalidates pending messages and late completion never reports accepted', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      await s.enqueue('b')
      s.setLive({ state: 'awaiting_input', runVersion: 2 })
      let finish!: (value: { ok: boolean }) => void
      let started!: () => void
      const began = new Promise<void>((resolve) => {
        started = resolve
      })
      s.setHandoff(async (text) => {
        s.delivered.push(text)
        started()
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const pending = s
        .execute({ ...s.target, action: 'deliver', expectedVersion: 2 })
        .catch((error) => error)
      await began
      s.setLive({ generation: 2, state: 'cancelled' })
      await s.queue.cancelGeneration('session-1', 1)
      finish({ ok: true })
      expect(await pending).toMatchObject({ code: 'stale_generation' })
      expect(s.delivered).toEqual(['a'])
      expect(JSON.stringify(s.events)).not.toContain('delivery_accepted')
      expect(
        (await s.execute({ runtimeSessionId: 'session-1', expectedGeneration: 2, action: 'read' }))
          .items
      ).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  test('revocation and generation changes after an asynchronous admission prevent side effects', async () => {
    const s = setup()
    try {
      await s.enqueue('a')
      s.revoke()
      await expect(
        s.execute({ ...s.target, action: 'remove', expectedVersion: 1, messageId: 'a' })
      ).rejects.toMatchObject({ code: 'channel_unauthorized' })
      const peer = createFollowUpQueue(s.options)
      await expect(
        peer.execute(
          { ...s.target, action: 'enqueue', expectedVersion: 1, messageId: 'b', text: 'b' },
          {
            idempotencyKey: 'late',
            authorize: async () => {
              s.setLive({ generation: 2 })
              return () => {}
            },
          }
        )
      ).rejects.toMatchObject({ code: 'stale_generation' })
      expect(s.delivered).toEqual([])
      expect(s.events).toHaveLength(1)
    } finally {
      s.cleanup()
    }
  })

  test('ambiguous delivery and restart never resend, and on-disk state contains no prompt plaintext', async () => {
    const s = setup()
    try {
      const text = 'PRIVATE FOLLOW UP MUST STAY SEALED'
      await s.enqueue('a', text)
      s.setLive({ state: 'awaiting_input', runVersion: 2 })
      s.setHandoff(async () => new Promise(() => {}))
      const request = { ...s.target, action: 'deliver' as const, expectedVersion: 1 }
      const outcome = await s.execute(request, 'send')
      expect(outcome.items[0]?.state).toBe('ambiguous')
      const peer = createFollowUpQueue(s.options)
      const replay = await peer.execute(request, { idempotencyKey: 'send', authorize: s.authorize })
      expect(replay.items[0]?.state).toBe('ambiguous')
      expect(readFileSync(s.queue.storageFile, 'utf8')).not.toContain(text)
      expect(JSON.stringify(s.events)).not.toContain(text)
      await expect(
        s.execute({ ...s.target, action: 'deliver', expectedVersion: outcome.version })
      ).rejects.toMatchObject({ code: 'delivery_ambiguous' })
      await s.execute({
        ...s.target,
        action: 'remove',
        expectedVersion: outcome.version,
        messageId: 'a',
      })
      await expect(s.enqueue('a', text)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    } finally {
      s.cleanup()
    }
  })

  test('bounds messages, aggregate bytes and exact reorder membership', async () => {
    const s = setup()
    try {
      for (let i = 0; i < 16; i++) await s.enqueue(`m-${i}`)
      await expect(s.enqueue('overflow')).rejects.toMatchObject({ code: 'limit_exceeded' })
      await expect(
        s.execute({ ...s.target, action: 'reorder', expectedVersion: 16, messageIds: ['m-1'] })
      ).rejects.toMatchObject({ code: 'invalid_state' })
    } finally {
      s.cleanup()
    }
    const bytes = setup()
    try {
      for (let i = 0; i < 4; i++) await bytes.enqueue(`m-${i}`, 'x'.repeat(16_384))
      await expect(bytes.enqueue('overflow', 'a')).rejects.toMatchObject({ code: 'limit_exceeded' })
    } finally {
      bytes.cleanup()
    }
  })
})
