import { describe, expect, test } from 'bun:test'

import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
import type { FollowUpQueueSnapshot } from '@adea-ai/types/dev-runtime-follow-ups'
import type { DevRuntimeService } from '../src/platform'
import {
  canDeliverNext,
  ChatRuntimeError,
  createFollowUpQueueController,
  createFollowUpQueuePort,
  followUpDeliveryText,
  followUpLastDeliveryText,
  latestQueueVersion,
  type FollowUpIdentity,
  type FollowUpQueuePort,
  type FollowUpQueueView,
} from '../src/chat/model'

const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  runtimeNodeId: '00000000-0000-4000-8000-000000000003',
}
const IDENTITY: FollowUpIdentity = { runtimeSessionId: 'session-1', generation: 2 }

function snapshot(overrides: Partial<FollowUpQueueSnapshot> = {}): FollowUpQueueSnapshot {
  return {
    schemaVersion: 1,
    runtimeSessionId: IDENTITY.runtimeSessionId,
    generation: IDENTITY.generation,
    version: 1,
    delivery: 'busy',
    items: [],
    ...overrides,
  }
}
const item = (id: string, state: 'queued' | 'dispatching' | 'ambiguous' = 'queued') => ({
  id,
  text: `text ${id}`,
  bytes: `text ${id}`.length,
  state,
})
const reject = (code: string, message = code) =>
  new ChatRuntimeError({ code, retryable: false, message } as never)

type Call = { method: string; input: Record<string, unknown> }
/** A scripted port: each method returns the next queued outcome, recording what it was asked. */
function scriptedPort(script: Record<string, Array<FollowUpQueueSnapshot | Error>>) {
  const calls: Call[] = []
  const step = (method: string) => async (_identity: FollowUpIdentity, input?: object) => {
    calls.push({ method, input: { ...input } })
    const outcome = script[method]?.shift()
    if (outcome === undefined) throw new Error(`unscripted ${method}`)
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  const port: FollowUpQueuePort = {
    read: step('read'),
    enqueue: step('enqueue'),
    remove: step('remove'),
    deliver: step('deliver'),
  }
  return { port, calls }
}
function ready(port: FollowUpQueuePort) {
  let n = 0
  const controller = createFollowUpQueueController({
    port,
    identity: IDENTITY,
    randomId: () => `id${++n}`,
  })
  const views: FollowUpQueueView[] = []
  controller.subscribe((view) => views.push(view))
  return { controller, views }
}

describe('follow-up queue controller', () => {
  test('a successful read shows the host snapshot; a refused read offers no queue', async () => {
    const a = scriptedPort({ read: [snapshot({ version: 3, items: [item('m1')] })] })
    const first = ready(a.port)
    expect(first.controller.view().status).toBe('loading')
    await first.controller.refresh()
    expect(first.controller.view().status).toBe('ready')
    expect(first.controller.view().snapshot?.items.map((entry) => entry.id)).toEqual(['m1'])

    for (const code of ['stale_generation', 'capability_denied', 'unsupported_capability']) {
      const b = scriptedPort({ read: [reject(code)] })
      const second = ready(b.port)
      await second.controller.refresh()
      expect(second.controller.view().status).toBe('unavailable')
    }
    // No host answer and nothing shown yet: no dead control either.
    const c = scriptedPort({ read: [new Error('offline')] })
    const third = ready(c.port)
    await third.controller.refresh()
    expect(third.controller.view().status).toBe('unavailable')
  })

  test('a late older read never moves the queue backwards', async () => {
    const { port } = scriptedPort({
      read: [snapshot({ version: 5, items: [item('m1')] }), snapshot({ version: 4 })],
    })
    const { controller } = ready(port)
    await controller.refresh()
    await controller.refresh()
    expect(controller.view().snapshot?.version).toBe(5)
  })

  test('enqueue carries the version it was drawn from and shows the answer', async () => {
    const { port, calls } = scriptedPort({
      read: [snapshot({ version: 4 })],
      enqueue: [snapshot({ version: 5, items: [item('message-id1')] })],
    })
    const { controller } = ready(port)
    await controller.refresh()
    expect(await controller.enqueue('then run the tests')).toBe(true)
    expect(calls[1]).toMatchObject({
      method: 'enqueue',
      input: { expectedVersion: 4, text: 'then run the tests' },
    })
    expect(typeof calls[1]!.input['messageId']).toBe('string')
    expect(typeof calls[1]!.input['idempotencyKey']).toBe('string')
    expect(controller.view().snapshot?.version).toBe(5)
    expect(controller.view().pending).toBeUndefined()
  })

  test('blank, oversized and over-limit messages never reach the host', async () => {
    const full = Array.from({ length: 16 }, (_, index) => item(`m${index}`))
    const { port, calls } = scriptedPort({ read: [snapshot({ items: full })] })
    const { controller } = ready(port)
    await controller.refresh()
    expect(await controller.enqueue('   ')).toBe(false)
    expect(await controller.enqueue('x')).toBe(false)
    expect(controller.view().notice?.message).toContain('at most 16 messages')
    const emptyQueue = scriptedPort({ read: [snapshot()] })
    const other = ready(emptyQueue.port)
    await other.controller.refresh()
    expect(await other.controller.enqueue('é'.repeat(9_000))).toBe(false)
    expect(other.controller.view().notice?.message).toContain('bytes')
    expect(calls.map((call) => call.method)).toEqual(['read'])
    expect(emptyQueue.calls.map((call) => call.method)).toEqual(['read'])
  })

  test('a stale version re-reads and asks the person to look again, never replays', async () => {
    const { port, calls } = scriptedPort({
      read: [snapshot({ version: 4 }), snapshot({ version: 6, items: [item('other')] })],
      enqueue: [reject('stale_version')],
    })
    const { controller } = ready(port)
    await controller.refresh()
    expect(await controller.enqueue('mine')).toBe(false)
    expect(calls.map((call) => call.method)).toEqual(['read', 'enqueue', 'read'])
    expect(controller.view().snapshot?.version).toBe(6)
    expect(controller.view().notice?.code).toBe('stale_version')
  })

  test('a second change while one is in flight is refused with a notice', async () => {
    let release!: (value: FollowUpQueueSnapshot) => void
    const calls: string[] = []
    const port: FollowUpQueuePort = {
      read: async () => snapshot({ version: 1, items: [item('m1')] }),
      enqueue: async () => {
        calls.push('enqueue')
        return new Promise((resolve) => (release = resolve))
      },
      remove: async () => {
        calls.push('remove')
        return snapshot()
      },
      deliver: async () => snapshot(),
    }
    const { controller } = ready(port)
    await controller.refresh()
    const first = controller.enqueue('first')
    expect(controller.view().pending).toBe('enqueue')
    expect(await controller.remove('m1')).toBe(false)
    expect(controller.view().notice?.message).toContain('Wait')
    release(snapshot({ version: 2 }))
    expect(await first).toBe(true)
    expect(calls).toEqual(['enqueue'])
  })

  test('a retry after an unknown outcome reuses the key and message identity; a refusal does not', async () => {
    const { port, calls } = scriptedPort({
      read: [snapshot({ version: 1 })],
      enqueue: [reject('timeout'), reject('limit_exceeded'), snapshot({ version: 2 })],
    })
    const { controller } = ready(port)
    await controller.refresh()
    await controller.enqueue('same text')
    await controller.enqueue('same text')
    await controller.enqueue('same text')
    const [first, retry, afterRefusal] = calls.slice(1)
    expect(retry!.input['idempotencyKey']).toBe(first!.input['idempotencyKey'])
    expect(retry!.input['messageId']).toBe(first!.input['messageId'])
    expect(afterRefusal!.input['idempotencyKey']).not.toBe(first!.input['idempotencyKey'])
    expect(controller.view().snapshot?.version).toBe(2)
  })

  test('remove is offered only for a message the host can still withdraw', async () => {
    const { port, calls } = scriptedPort({
      read: [
        snapshot({
          version: 3,
          items: [item('a'), item('b', 'dispatching'), item('c', 'ambiguous')],
        }),
      ],
      remove: [
        snapshot({ version: 4, items: [item('b', 'dispatching'), item('c', 'ambiguous')] }),
        snapshot({ version: 5, items: [item('b', 'dispatching')] }),
      ],
    })
    const { controller } = ready(port)
    await controller.refresh()
    expect(await controller.remove('b')).toBe(false)
    expect(await controller.remove('missing')).toBe(false)
    expect(await controller.remove('a')).toBe(true)
    expect(await controller.remove('c')).toBe(true)
    expect(
      calls.filter((call) => call.method === 'remove').map((call) => call.input['messageId'])
    ).toEqual(['a', 'c'])
  })

  test('delivery is offered only when the host is ready, the head is queued and nothing is claimed', async () => {
    expect(canDeliverNext(snapshot({ delivery: 'ready', items: [item('a')] }))).toBe(true)
    expect(canDeliverNext(snapshot({ delivery: 'busy', items: [item('a')] }))).toBe(false)
    expect(canDeliverNext(snapshot({ delivery: 'unavailable', items: [item('a')] }))).toBe(false)
    expect(canDeliverNext(snapshot({ delivery: 'ready', items: [] }))).toBe(false)
    expect(canDeliverNext(snapshot({ delivery: 'ready', items: [item('a', 'ambiguous')] }))).toBe(
      false
    )
    expect(canDeliverNext(snapshot({ delivery: 'ready', items: [item('a', 'dispatching')] }))).toBe(
      false
    )

    const { port, calls } = scriptedPort({
      read: [snapshot({ version: 7, delivery: 'ready', items: [item('a'), item('b')] })],
      deliver: [
        snapshot({
          version: 8,
          delivery: 'busy',
          items: [item('b')],
          lastDelivery: { messageId: 'a', status: 'accepted' },
        }),
      ],
    })
    const { controller } = ready(port)
    await controller.refresh()
    expect(await controller.deliver()).toBe(true)
    expect(calls[1]).toMatchObject({ method: 'deliver', input: { expectedVersion: 7 } })
    expect(controller.view().snapshot?.lastDelivery?.messageId).toBe('a')
    // Busy again: nothing more is sent without a fresh ready boundary.
    expect(await controller.deliver()).toBe(false)
    expect(calls.map((call) => call.method)).toEqual(['read', 'deliver'])
  })

  test('an ambiguous delivery is not retried; the host refusal is shown as the host said it', async () => {
    const { port } = scriptedPort({
      read: [snapshot({ version: 2, delivery: 'ready', items: [item('a')] })],
      deliver: [reject('delivery_ambiguous', 'a prior delivery claim must be resolved')],
    })
    const { controller } = ready(port)
    await controller.refresh()
    expect(await controller.deliver()).toBe(false)
    expect(controller.view().notice).toMatchObject({
      tone: 'error',
      code: 'delivery_ambiguous',
      message: 'a prior delivery claim must be resolved',
    })
    expect(controller.view().status).toBe('ready')
    expect(controller.view().snapshot?.version).toBe(2)
  })

  test('observing a newer queue.updated version re-reads; an equal or older one does not', async () => {
    const { port, calls } = scriptedPort({
      read: [snapshot({ version: 3 }), snapshot({ version: 5, items: [item('x')] })],
    })
    const { controller } = ready(port)
    await controller.refresh()
    controller.observeVersion(3)
    controller.observeVersion(2)
    expect(calls).toHaveLength(1)
    controller.observeVersion(5)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toHaveLength(2)
    expect(controller.view().snapshot?.version).toBe(5)
  })

  test('a disposed controller ignores late answers', async () => {
    let release!: (value: FollowUpQueueSnapshot) => void
    const port: FollowUpQueuePort = {
      read: () => new Promise((resolve) => (release = resolve)),
      enqueue: async () => snapshot(),
      remove: async () => snapshot(),
      deliver: async () => snapshot(),
    }
    const { controller, views } = ready(port)
    const reading = controller.refresh()
    controller.dispose()
    release(snapshot({ version: 9 }))
    await reading
    expect(views).toHaveLength(0)
    expect(controller.view().status).toBe('loading')
  })
})

describe('follow-up wording', () => {
  test('never claims more than the host said', () => {
    expect(followUpDeliveryText(snapshot())).toBe('')
    expect(followUpDeliveryText(snapshot({ delivery: 'busy', items: [item('a')] }))).toContain(
      'Nothing is sent automatically'
    )
    expect(followUpDeliveryText(snapshot({ delivery: 'ready', items: [item('a')] }))).toContain(
      'when you choose'
    )
    expect(
      followUpDeliveryText(snapshot({ delivery: 'unavailable', items: [item('a')] }))
    ).toContain('not available')
    expect(followUpDeliveryText(snapshot({ items: [item('a', 'ambiguous')] }))).toContain(
      'not retried automatically'
    )
    expect(
      followUpLastDeliveryText(snapshot({ lastDelivery: { messageId: 'a', status: 'accepted' } }))
    ).toContain('does not confirm the agent has read it')
    expect(
      followUpLastDeliveryText(snapshot({ lastDelivery: { messageId: 'a', status: 'ambiguous' } }))
    ).toContain('may or may not')
    expect(followUpLastDeliveryText(snapshot())).toBeUndefined()
  })
})

describe('follow-up queue port', () => {
  // A test helper that needs no captured scope; local so each block reads on its own.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  function service(reply: (command: DevCommand) => unknown) {
    const commands: DevCommand[] = []
    const fake = {
      execute: async (command: DevCommand): Promise<DevReply> => {
        commands.push(command)
        const value = reply(command)
        return value instanceof ChatRuntimeError
          ? ({
              ok: false,
              error: { code: value.code, retryable: false, message: value.message },
            } as never)
          : ({ ok: true, value } as never)
      },
    } as unknown as DevRuntimeService
    return { fake, commands }
  }

  test('reads without a key and mutates with a printable-ASCII key, bound to the session generation', async () => {
    const { fake, commands } = service(() => snapshot({ version: 2 }))
    const port = createFollowUpQueuePort(fake, SCOPE, { randomId: () => 'abc-123' })
    await port.read(IDENTITY)
    await port.enqueue(IDENTITY, { expectedVersion: 1, messageId: 'm1', text: 'hello' })
    await port.remove(IDENTITY, { expectedVersion: 2, messageId: 'm1' })
    await port.deliver(IDENTITY, { expectedVersion: 2 })
    expect(commands.map((command) => command.operation)).toEqual([
      'dev.session.followUps',
      'dev.session.followUps',
      'dev.session.followUps',
      'dev.session.followUps',
    ])
    expect(commands[0]!.body).toEqual({
      runtimeSessionId: 'session-1',
      expectedGeneration: 2,
      action: 'read',
    })
    expect(commands[0]!.idempotencyKey).toBeUndefined()
    expect(commands[1]!.body).toEqual({
      runtimeSessionId: 'session-1',
      expectedGeneration: 2,
      action: 'enqueue',
      expectedVersion: 1,
      messageId: 'm1',
      text: 'hello',
    })
    for (const command of commands.slice(1)) {
      expect(command.idempotencyKey).toMatch(/^[\x21-\x7e]{1,128}$/)
      expect(command.resource).toEqual({ kind: 'runtime_session', id: 'session-1', generation: 2 })
    }
  })

  test('a malformed snapshot, or one for another session or generation, is refused', async () => {
    for (const reply of [
      { nonsense: true },
      snapshot({ runtimeSessionId: 'session-2' }),
      snapshot({ generation: 3 }),
    ]) {
      const { fake } = service(() => reply)
      const port = createFollowUpQueuePort(fake, SCOPE)
      await expect(port.read(IDENTITY)).rejects.toThrow()
    }
  })

  test('a host refusal surfaces with its code', async () => {
    const { fake } = service(() => reject('stale_version', 'follow-up queue version changed'))
    const port = createFollowUpQueuePort(fake, SCOPE)
    await expect(port.read(IDENTITY)).rejects.toMatchObject({ code: 'stale_version' })
  })
})

describe('queue.updated observation', () => {
  // A test helper that needs no captured scope; local so each block reads on its own.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const event = (overrides: Record<string, unknown>) =>
    ({
      kind: 'queue.updated',
      runtimeSessionId: IDENTITY.runtimeSessionId,
      generation: IDENTITY.generation,
      payload: { version: 4 },
      ...overrides,
    }) as never

  test('names the newest version for this session generation only', () => {
    expect(latestQueueVersion([], IDENTITY)).toBeUndefined()
    expect(
      latestQueueVersion(
        [
          event({ payload: { version: 4 } }),
          event({ payload: { version: 7 } }),
          event({ payload: { version: 5 } }),
          event({ payload: { version: 99 }, generation: 1 }),
          event({ payload: { version: 98 }, runtimeSessionId: 'other' }),
          {
            kind: 'turn.user_input',
            runtimeSessionId: 'session-1',
            generation: 2,
            payload: {},
          } as never,
        ],
        IDENTITY
      )
    ).toBe(7)
  })
})
