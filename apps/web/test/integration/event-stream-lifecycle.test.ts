// Route-level lifecycle of the workspace event stream and its request-scoped
// database client. The production route handler runs against the real request
// scope and the real `applicationDatabase()`; only the database driver, the
// principal/authorization seam and the event-log reads are replaced by
// controllable fakes, so each test can hold a read, a reauthorization or a
// closer open at the exact moment the subscriber cancels, the read fails, or
// the stream ends.
//
// Properties under test, for every one of cancel / abort / error / success:
//   - the request's client closes exactly once;
//   - it closes only after the in-flight operation has settled, never under it;
//   - nothing opens a replacement client or queries after the subscriber left;
//   - the connection slot frees when delivery is cancelled, not when the
//     producer finishes unwinding;
//   - the scope's teardown is handed to the runtime (`waitUntil`) as one
//     promise that settles after the last closer, rejecting or slow included.
//
// No database is needed. Lane: apps/web/test/integration (react-server
// condition):
//   bun test --conditions=react-server apps/web/test/integration/event-stream-lifecycle.test.ts

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('@tanstack/solid-router', () => ({
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))

type Client = { id: number; closes: number; db: { clientId: number } }
type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

type Principal = { principal: { kind: 'user'; userId: string } }
const USER = 'usr_lifecycle'
const principal = (): Principal => ({ principal: { kind: 'user', userId: USER } })

const ctl = {
  clients: [] as Client[],
  log: [] as string[],
  usedAfterClose: [] as string[],
  closeGate: undefined as Promise<void> | undefined,
  closeFailure: false,
  behavior: {} as Partial<{
    window: () => Promise<{ earliest: number | null; latest: number }>
    list: (afterSequence: number) => Promise<unknown[]>
    poll: (afterSequence: number) => Promise<unknown[]>
    classify: (page: readonly { workspaceSequence: number }[]) => Promise<unknown[] | null>
    mark: () => Promise<void>
    principal: () => Promise<Principal | null>
    authorize: (call: number) => Promise<{ allowed: boolean }>
  }>,
  authorizeCalls: 0,
}

function track(op: string, db: unknown) {
  const client = ctl.clients.find((candidate) => candidate.db === db)
  ctl.log.push(`${op}#${client?.id ?? '?'}`)
  if (client && client.closes > 0) ctl.usedAfterClose.push(`${op}#${client.id}`)
}

const realDb = await import('@adea-ai/db')
mock.module('@adea-ai/db', () => ({
  ...realDb,
  createDatabase: () => {
    const id = ctl.clients.length + 1
    const client: Client = { id, closes: 0, db: { clientId: id } }
    ctl.clients.push(client)
    return {
      db: client.db,
      close: async () => {
        client.closes += 1
        if (ctl.closeGate) await ctl.closeGate
        if (ctl.closeFailure) throw new Error('close failed')
      },
    }
  },
  workspaceEventWindow: async (db: unknown) => {
    track('window', db)
    return (ctl.behavior.window ?? (async () => ({ earliest: null, latest: 0 })))()
  },
  listWorkspaceEventsAfter: async (db: unknown, _workspaceId: string, after: number) => {
    track('list', db)
    return (ctl.behavior.list ?? (async () => []))(after)
  },
  prepareWorkspaceEventsAfter: (db: unknown) => async (after: number) => {
    track('poll', db)
    return (ctl.behavior.poll ?? (async () => []))(after)
  },
  classifyWorkspaceEventsForUser: async (
    db: unknown,
    _workspaceId: string,
    _userId: string,
    page: readonly { workspaceSequence: number }[]
  ) => {
    track('classify', db)
    const classify =
      ctl.behavior.classify ??
      (async (events) =>
        events.map((event) => ({ kind: 'withheld', workspaceSequence: event.workspaceSequence })))
    return classify(page)
  },
  markEventDispatchesNotified: async (db: unknown) => {
    track('mark', db)
    await (ctl.behavior.mark ?? (async () => undefined))()
  },
}))

const { applicationDatabase } = await import('../../src/server/database')
mock.module('../../src/server/workspace-principal', () => ({
  resolveWorkspacePrincipal: async () => {
    // Like the production resolver, it reads through the request's client.
    track('principal', applicationDatabase())
    return (ctl.behavior.principal ?? (async () => principal()))()
  },
}))
mock.module('../../src/server/workspace-authorization', () => ({
  authorizeWorkspace: async () => {
    track('authorize', applicationDatabase())
    ctl.authorizeCalls += 1
    return (ctl.behavior.authorize ?? (async () => ({ allowed: true })))(ctl.authorizeCalls)
  },
}))
const realStream = await import('../../src/server/workspace-event-stream')
mock.module('../../src/server/workspace-event-stream', () => ({
  ...realStream,
  STREAM_POLL_MS: 5,
  STREAM_HEARTBEAT_MS: 60_000,
  STREAM_REAUTHORIZE_MS: 25,
}))

const { captureWaitUntil } = await import('../../src/server/background-task')
const { encodeWorkspaceEventCursor } = await import('../../src/server/event-cursor')
const route =
  (await import('../../src/start/routes/api/v1/workspaces/$workspaceId/events')) as unknown as {
    Route: {
      options: {
        server: {
          handlers: {
            GET: (context: {
              request: Request
              params: Record<string, string>
            }) => Promise<Response>
          }
        }
      }
    }
  }

type Stream = {
  abort: AbortController
  response: Response
  reader: ReadableStreamDefaultReader<Uint8Array>
  text: () => string
  done: Promise<void>
}
const open: Stream[] = []
let waited: Promise<unknown>[] = []

async function connect(workspaceId: string, cursor?: string): Promise<Stream> {
  const abort = new AbortController()
  const url = `https://adea.test/api/v1/workspaces/${workspaceId}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
  const response = await route.Route.options.server.handlers.GET({
    request: new Request(url, { signal: abort.signal }),
    params: { workspaceId },
  })
  if (!response.body) return { abort, response } as unknown as Stream
  const reader = response.body.getReader()
  let received = ''
  const decoder = new TextDecoder()
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        received += decoder.decode(chunk.value)
      }
    } catch {
      // Cancelled by the test.
    }
  })()
  const stream = { abort, response, reader, text: () => received, done }
  open.push(stream)
  return stream
}

async function until(condition: () => boolean, label: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))
const closes = () => ctl.clients.map((client) => client.closes)
const opsOn = (name: string) => ctl.log.filter((entry) => entry.startsWith(`${name}#`)).length

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://app:secret@127.0.0.1:1/agent_hq'
  process.env.NEON_AUTH_COOKIE_SECRET = 'x'.repeat(48)
  ctl.clients.length = 0
  ctl.log.length = 0
  ctl.usedAfterClose.length = 0
  ctl.closeGate = undefined
  ctl.closeFailure = false
  ctl.behavior = {}
  ctl.authorizeCalls = 0
  waited = []
  captureWaitUntil((promise) => {
    waited.push(promise)
  })
})

afterEach(async () => {
  for (const stream of open.splice(0)) {
    stream.abort.abort()
    await stream.reader.cancel().catch(() => undefined)
  }
  captureWaitUntil(undefined)
  await settle()
})

describe('workspace event stream: request-scoped client lifecycle', () => {
  test('one client serves the whole request, reauthorization included, and closes once at the end', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    // Revoked at the second authorization (the first reauthorization).
    ctl.behavior.authorize = async (call) => ({ allowed: call < 2 })
    const stream = await connect(workspaceId)
    await stream.done

    expect(stream.text()).toContain('"reason":"membership-revoked"')
    // Principal, authorization, window, poll, reauthorization: every one used
    // client #1. Nothing opened a second client.
    expect(ctl.clients).toHaveLength(1)
    expect(opsOn('principal')).toBeGreaterThanOrEqual(2)
    expect(closes()).toEqual([1])
    expect(ctl.usedAfterClose).toEqual([])
  })

  test('events appended after the stream opened are delivered, then the stream ends cleanly', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    let appended = false
    ctl.behavior.poll = async (after) =>
      appended && after < 7 ? [{ workspaceSequence: 7 }] : ([] as unknown[])
    ctl.behavior.authorize = async (call) => ({ allowed: call < 2 })
    appended = true
    const stream = await connect(workspaceId)
    await stream.done

    expect(stream.text()).toContain('workspace.withheld')
    expect(stream.text()).toContain('"workspaceSequence":7')
    expect(opsOn('mark')).toBe(1)
    expect(closes()).toEqual([1])
  })

  test('cancelling while a poll read is pending holds the client until the read settles, then closes it once', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    const read = deferred<unknown[]>()
    ctl.behavior.poll = () => read.promise
    const stream = await connect(workspaceId)
    await until(() => opsOn('poll') === 1, 'the poll read to start')

    await stream.reader.cancel()
    await settle()
    // The consumer is gone but the read is still in flight on the client.
    expect(closes()).toEqual([0])

    read.resolve([{ workspaceSequence: 9 }])
    await until(() => closes()[0] === 1, 'the client to close')
    await settle()
    expect(closes()).toEqual([1])
    // The late page was neither classified nor marked, and no reauthorization
    // or replacement client followed the cancellation.
    expect(opsOn('classify')).toBe(0)
    expect(opsOn('mark')).toBe(0)
    expect(opsOn('poll')).toBe(1)
    expect(ctl.clients).toHaveLength(1)
    expect(ctl.usedAfterClose).toEqual([])
  })

  test('aborting while a reauthorization is pending opens no replacement client and runs no further query', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    const resolving = deferred<Principal | null>()
    let principalCalls = 0
    ctl.behavior.principal = () => {
      principalCalls += 1
      return principalCalls === 1 ? Promise.resolve(principal()) : resolving.promise
    }
    const stream = await connect(workspaceId)
    await until(() => principalCalls === 2, 'the reauthorization to start')
    const polls = opsOn('poll')
    const authorizations = opsOn('authorize')

    stream.abort.abort()
    await settle()
    expect(closes()).toEqual([0])

    resolving.resolve(principal())
    await until(() => closes()[0] === 1, 'the client to close')
    await settle()
    expect(closes()).toEqual([1])
    expect(ctl.clients).toHaveLength(1)
    expect(opsOn('authorize')).toBe(authorizations)
    expect(opsOn('poll')).toBe(polls)
    expect(ctl.usedAfterClose).toEqual([])
  })

  test('aborting while the authorization check is pending ends the stream without delivering a verdict', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    const verdict = deferred<{ allowed: boolean }>()
    ctl.behavior.authorize = (call) =>
      call === 1 ? Promise.resolve({ allowed: true }) : verdict.promise
    const stream = await connect(workspaceId)
    await until(() => ctl.authorizeCalls === 2, 'the reauthorization check to start')

    stream.abort.abort()
    verdict.resolve({ allowed: false })
    await until(() => closes()[0] === 1, 'the client to close')
    await settle()
    // A verdict that arrives after the subscriber left is not framed.
    expect(stream.text()).not.toContain('stream_unavailable')
    expect(closes()).toEqual([1])
    expect(ctl.usedAfterClose).toEqual([])
  })

  test('cancelling during classification stops before cursor signing, delivery and the dispatch mark', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    const classified = deferred<unknown[] | null>()
    let served = false
    ctl.behavior.poll = async () => {
      if (served) return []
      served = true
      return [{ workspaceSequence: 3 }]
    }
    ctl.behavior.classify = () => classified.promise
    const stream = await connect(workspaceId)
    await until(() => opsOn('classify') === 1, 'classification to start')

    await stream.reader.cancel()
    classified.resolve([{ kind: 'withheld', workspaceSequence: 3 }])
    await until(() => closes()[0] === 1, 'the client to close')
    await settle()
    expect(stream.text()).not.toContain('workspace.withheld')
    expect(opsOn('mark')).toBe(0)
    expect(closes()).toEqual([1])
    expect(ctl.usedAfterClose).toEqual([])
  })

  test('cancelling during replay reads no further page and marks nothing', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    const cursor = (await encodeWorkspaceEventCursor({ sequence: 2, workspaceId }))!
    expect(cursor).toBeTruthy()
    const page = deferred<unknown[]>()
    ctl.behavior.window = async () => ({ earliest: 1, latest: 5 })
    ctl.behavior.list = () => page.promise
    const stream = await connect(workspaceId, cursor)
    await until(() => opsOn('list') === 1, 'the replay read to start')

    stream.abort.abort()
    await settle()
    expect(closes()).toEqual([0])
    page.resolve([{ workspaceSequence: 3 }])
    await until(() => closes()[0] === 1, 'the client to close')
    await settle()
    expect(opsOn('classify')).toBe(0)
    expect(opsOn('mark')).toBe(0)
    expect(opsOn('list')).toBe(1)
    expect(closes()).toEqual([1])
  })

  test('a failing poll read ends the stream and closes the client once', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    ctl.behavior.poll = async () => {
      throw new Error('database unavailable')
    }
    const stream = await connect(workspaceId)
    await stream.done
    await until(() => closes()[0] === 1, 'the client to close')
    await settle()
    expect(closes()).toEqual([1])
    expect(ctl.clients).toHaveLength(1)
    expect(opsOn('poll')).toBe(1)
  })

  test('a failing reauthorization ends the stream and closes the client once', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    ctl.behavior.authorize = async (call) => {
      if (call === 1) return { allowed: true }
      throw new Error('membership lookup failed')
    }
    const stream = await connect(workspaceId)
    await stream.done
    await settle()
    expect(closes()).toEqual([1])
    expect(ctl.clients).toHaveLength(1)
  })

  test('the connection slot frees on cancel, before the pending read lets the producer unwind', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    const read = deferred<unknown[]>()
    ctl.behavior.poll = () => read.promise
    const streams: Stream[] = []
    for (let index = 0; index < 8; index += 1) streams.push(await connect(workspaceId))
    const refused = await route.Route.options.server.handlers.GET({
      request: new Request(`https://adea.test/api/v1/workspaces/${workspaceId}/events`),
      params: { workspaceId },
    })
    expect(refused.status).toBe(429)
    await until(() => opsOn('poll') === 8, 'every producer to be blocked on its read')

    await streams[0]!.reader.cancel()
    // The producer behind the cancelled stream is still blocked on its read, so
    // its client is still open; the slot is nevertheless free again.
    expect(closes()[0]).toBe(0)
    const admitted = await connect(workspaceId)
    expect(admitted.response.status).toBe(200)
    read.resolve([])
  })

  test('cancelling during the poll interval wakes the producer instead of waiting the interval out', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const heldPolls: Array<() => void> = []
    const cleared: unknown[] = []
    // The poll interval (5 ms in this suite) is made to never fire on its own.
    globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 5) {
        const handle = { poll: handler }
        heldPolls.push(handler)
        return handle as unknown as ReturnType<typeof setTimeout>
      }
      return realSetTimeout(handler, ms, ...rest)
    }) as typeof setTimeout
    globalThis.clearTimeout = ((handle: unknown) => {
      cleared.push(handle)
      if (!(handle as { poll?: unknown })?.poll) realClearTimeout(handle as never)
    }) as typeof clearTimeout
    try {
      const stream = await connect(workspaceId)
      await until(() => heldPolls.length === 1, 'the producer to wait for its poll interval')
      expect(opsOn('poll')).toBe(0)

      await stream.reader.cancel()
      await until(() => closes()[0] === 1, 'the client to close without the interval firing')
      expect(cleared.length).toBeGreaterThan(0)
      expect(opsOn('poll')).toBe(0)
      expect(closes()).toEqual([1])
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  })

  test('teardown is handed to the runtime as one promise that waits for a slow closer', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    const closing = deferred()
    ctl.closeGate = closing.promise
    const stream = await connect(workspaceId)
    await until(() => opsOn('poll') >= 1, 'the stream to be live')
    expect(waited).toHaveLength(1)
    let settled = false
    void waited[0]!.then(() => {
      settled = true
    })

    await stream.reader.cancel()
    await until(() => closes()[0] === 1, 'the closer to start')
    await settle()
    // The closer has started but not finished: the runtime must keep waiting.
    expect(settled).toBe(false)

    closing.resolve()
    await until(() => settled, 'teardown to complete')
    expect(closes()).toEqual([1])
  })

  test('a rejecting closer neither breaks the stream end nor leaves teardown unsettled', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    ctl.closeFailure = true
    ctl.behavior.authorize = async (call) => ({ allowed: call < 2 })
    const stream = await connect(workspaceId)
    await stream.done
    let settled = false
    void waited[0]!.then(() => {
      settled = true
    })
    await until(() => settled, 'teardown to complete')
    expect(closes()).toEqual([1])
  })

  test('a handler that fails before streaming closes its client and registers settled teardown', async () => {
    const workspaceId = `ws_${crypto.randomUUID()}`
    ctl.behavior.authorize = async () => ({ allowed: false })
    const response = await route.Route.options.server.handlers.GET({
      request: new Request(`https://adea.test/api/v1/workspaces/${workspaceId}/events`),
      params: { workspaceId },
    })
    expect(response.status).toBe(404)
    await until(() => closes().length === 1 && closes()[0] === 1, 'the client to close')
    expect(waited).toHaveLength(1)
    await waited[0]
  })
})
