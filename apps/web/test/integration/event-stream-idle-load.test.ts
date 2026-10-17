// Query load and latency of an open workspace event stream, on a fake clock.
//
// The route handler is the production one, with the real request scope. Only the
// driver, the principal/authorization seam and the event-log reads are replaced by
// counters, and the stream constants are the real ones, so a simulated half hour
// counts the event-read and principal/authorization calls an idle subscriber makes.
// Those are call counts on mocks, not independently verified physical SQL or
// production telemetry. Hyperdrive is never involved.
//
// Properties:
//   - an idle stream's catch-up reads back off, and the 15-second heartbeat and the
//     30-second reauthorization keep their exact schedule while it does;
//   - an event appended during the backoff is delivered within the idle ceiling, and
//     the cadence returns to its base afterwards;
//   - a backlog larger than one page drains without waiting a poll interval per page;
//   - a revoked session or membership ends the stream at the reauthorization deadline,
//     before any event appended after it is delivered;
//   - a reconnect with the last cursor resumes exactly after it.
//
// No database is needed. Lane: apps/web/test/integration (react-server condition):
//   bun test --conditions=react-server apps/web/test/integration/event-stream-idle-load.test.ts

import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'

mock.module('@tanstack/solid-router', () => ({
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))

const USER = 'usr_idle_load'
const PAGE = 200

type Event = { workspaceSequence: number }
const ctl = {
  log: { poll: 0, list: 0, window: 0, principal: 0, authorize: 0, mark: 0 },
  // The durable log as the fakes see it: everything above `head` does not exist yet.
  head: 0,
  principalGone: false,
  membershipGone: false,
}

const eventsAfter = (after: number, limit: number): Event[] => {
  const page: Event[] = []
  for (let sequence = after + 1; sequence <= ctl.head && page.length < limit; sequence += 1) {
    page.push({ workspaceSequence: sequence })
  }
  return page
}

const realDb = await import('@adea-ai/db')
mock.module('@adea-ai/db', () => ({
  ...realDb,
  createDatabase: () => ({ db: {}, close: async () => undefined }),
  workspaceEventWindow: async () => {
    ctl.log.window += 1
    return { earliest: ctl.head > 0 ? 1 : null, latest: ctl.head }
  },
  listWorkspaceEventsAfter: async (_db: unknown, _workspaceId: string, after: number) => {
    ctl.log.list += 1
    return eventsAfter(after, PAGE)
  },
  prepareWorkspaceEventsAfter: () => async (after: number) => {
    ctl.log.poll += 1
    return eventsAfter(after, PAGE)
  },
  classifyWorkspaceEventsForUser: async (
    _db: unknown,
    _workspaceId: string,
    _userId: string,
    page: readonly Event[]
  ) => page.map((event) => ({ kind: 'withheld', workspaceSequence: event.workspaceSequence })),
  markEventDispatchesNotified: async () => {
    ctl.log.mark += 1
  },
}))
mock.module('../../src/server/workspace-principal', () => ({
  resolveWorkspacePrincipal: async () => {
    ctl.log.principal += 1
    return ctl.principalGone ? null : { principal: { kind: 'user', userId: USER } }
  },
}))
mock.module('../../src/server/workspace-authorization', () => ({
  authorizeWorkspace: async () => {
    ctl.log.authorize += 1
    return { allowed: !ctl.membershipGone }
  },
}))

// The real codec signs with WebCrypto, which settles on a real macrotask and cannot be paced
// by a fake clock. Its own tests live in event-stream.test.ts; here a transparent codec keeps
// the cursor's meaning (a sequence in a workspace) while staying on the microtask queue.
mock.module('../../src/server/event-cursor', () => ({
  encodeWorkspaceEventCursor: async (cursor: { sequence: number; workspaceId: string }) =>
    `c.${cursor.workspaceId}.${cursor.sequence}`,
  decodeWorkspaceEventCursor: async (token: string, workspaceId: string) => {
    const [, tokenWorkspace, sequence] = token.split('.')
    if (tokenWorkspace !== workspaceId) return { ok: false, reason: 'foreign-workspace' }
    return { ok: true, cursor: { sequence: Number(sequence), workspaceId } }
  },
}))

const { captureWaitUntil } = await import('../../src/server/background-task')
const { decodeWorkspaceEventCursor } = await import('../../src/server/event-cursor')
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

const STEP_MS = 250
const flush = async () => {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve()
}
/** Advance the fake clock in small steps, letting the stream's async work settle after each. */
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    jest.advanceTimersByTime(Math.min(STEP_MS, ms - elapsed))
    await flush()
  }
}

type Stream = { abort: AbortController; text: () => string; ended: () => boolean }
const open: Stream[] = []

async function connect(workspaceId: string, cursor?: string): Promise<Stream> {
  const abort = new AbortController()
  const url = `https://adea.test/api/v1/workspaces/${workspaceId}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
  const response = await route.Route.options.server.handlers.GET({
    request: new Request(url, { signal: abort.signal }),
    params: { workspaceId },
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  let ended = false
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += decoder.decode(chunk.value)
      }
    } catch {
      // Cancelled by the test.
    }
    ended = true
  })()
  const stream = { abort, text: () => received, ended: () => ended }
  open.push(stream)
  await flush()
  return stream
}

const count = (text: string, needle: string) => text.split(needle).length - 1
const sequences = (text: string) =>
  [...text.matchAll(/"workspaceSequence":(\d+)/g)].map((match) => Number(match[1]))

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://app:secret@127.0.0.1:1/agent_hq'
  process.env.NEON_AUTH_COOKIE_SECRET = 'x'.repeat(48)
  Object.assign(ctl.log, { poll: 0, list: 0, window: 0, principal: 0, authorize: 0, mark: 0 })
  ctl.head = 0
  ctl.principalGone = false
  ctl.membershipGone = false
  captureWaitUntil(() => undefined)
  jest.useFakeTimers()
})

afterEach(async () => {
  for (const stream of open.splice(0)) stream.abort.abort()
  await flush()
  jest.useRealTimers()
  captureWaitUntil(undefined)
})

const workspace = () => `ws_${crypto.randomUUID()}`

describe('idle stream query load', () => {
  test('an idle stream polls a fraction as often and keeps heartbeat and reauthorization exact', async () => {
    const stream = await connect(workspace())
    const idleMs = 29 * 60 * 1_000
    await advance(idleMs)

    // Before this change the catch-up read ran every second: 1,740 reads in 29 minutes.
    const previous = idleMs / 1_000
    expect(ctl.log.poll).toBeGreaterThan(300)
    expect(ctl.log.poll).toBeLessThan(previous * 0.25)

    // One principal read and one authorization per 30 seconds, as before.
    expect(ctl.log.principal - 1).toBe(Math.floor(idleMs / 30_000))
    expect(ctl.log.authorize - 1).toBe(Math.floor(idleMs / 30_000))
    // One heartbeat per 15 seconds, as before.
    expect(count(stream.text(), ': heartbeat')).toBe(Math.floor(idleMs / 15_000))
    expect(stream.ended()).toBe(false)

    const total = ctl.log.poll + ctl.log.principal - 1 + ctl.log.authorize - 1
    console.log(
      `idle 29 min: ${ctl.log.poll} polls (was ${previous}), ${total} reads (was ${previous + 2 * Math.floor(idleMs / 30_000)})`
    )
  })

  test('an event appended while idle arrives within the idle ceiling, and the cadence returns to one second', async () => {
    const stream = await connect(workspace())
    await advance(10 * 60 * 1_000)
    const pollsBefore = ctl.log.poll

    ctl.head = 1
    const appendedAt = Date.now()
    let deliveredAt: number | undefined
    for (let waited = 0; waited < 8_000 && deliveredAt === undefined; waited += STEP_MS) {
      await advance(STEP_MS)
      if (sequences(stream.text()).includes(1)) deliveredAt = Date.now()
    }
    expect(deliveredAt).toBeDefined()
    expect(deliveredAt! - appendedAt).toBeLessThanOrEqual(5_000 + 2 * STEP_MS)
    expect(ctl.log.poll).toBeGreaterThan(pollsBefore)

    // Back at the base cadence: ten seconds later there have been about ten polls.
    const afterDelivery = ctl.log.poll
    await advance(10_000)
    expect(ctl.log.poll - afterDelivery).toBeGreaterThanOrEqual(7)
    expect(ctl.log.poll - afterDelivery).toBeLessThanOrEqual(11)
  })

  test('a backlog of more than one page drains in one burst, not one page per poll interval', async () => {
    const stream = await connect(workspace())
    await advance(10 * 60 * 1_000)

    ctl.head = 450
    const appendedAt = Date.now()
    let firstAt: number | undefined
    let drainedAt: number | undefined
    for (let waited = 0; waited < 12_000 && drainedAt === undefined; waited += STEP_MS) {
      await advance(STEP_MS)
      const seen = sequences(stream.text())
      if (firstAt === undefined && seen.length > 0) firstAt = Date.now()
      if (seen.includes(450)) drainedAt = Date.now()
    }
    expect(drainedAt).toBeDefined()
    // Pages of 200, 200 and 50 come from consecutive reads at the same wake. Paced one page per
    // interval they would span two idle intervals (10 s); here they span at most one step.
    expect(drainedAt! - firstAt!).toBeLessThanOrEqual(STEP_MS)
    expect(drainedAt! - appendedAt).toBeLessThanOrEqual(5_000 + 2 * STEP_MS)
    expect(sequences(stream.text())).toEqual(Array.from({ length: 450 }, (_, index) => index + 1))
    expect(ctl.log.mark).toBe(3)
  })
})

describe('authorization deadlines under backoff', () => {
  test('when a revocation and a poll fall due together, the revocation wins and nothing later is delivered', async () => {
    const stream = await connect(workspace())
    const startedAt = Date.now()
    // The idle schedule polls at 27s and again at 30s, the reauthorization deadline. Revoke
    // and append between them: the 30-second wake finds both due and must stop first.
    await advance(28_000)
    ctl.membershipGone = true
    ctl.head = 1
    await advance(5_000)

    expect(stream.text()).toContain('"reason":"membership-revoked"')
    expect(stream.ended()).toBe(true)
    expect(Date.now() - startedAt).toBeLessThanOrEqual(33_000)
    expect(sequences(stream.text()).includes(1)).toBe(false)
  })

  test('a revoked session ends an idle, backed-off stream at the recheck', async () => {
    const stream = await connect(workspace())
    await advance(2 * 60 * 1_000)
    expect(stream.ended()).toBe(false)
    ctl.principalGone = true
    await advance(30_000)

    expect(stream.text()).toContain('"reason":"session-revoked"')
    expect(stream.ended()).toBe(true)
  })
})

describe('reconnect continuity', () => {
  test('a reconnect with the last cursor resumes after it, with no gap or repeat', async () => {
    const workspaceId = workspace()
    ctl.head = 3
    const first = await connect(workspaceId)
    await advance(2_000)
    // A fresh subscriber starts at the head: nothing replayed.
    expect(sequences(first.text())).toEqual([])

    ctl.head = 7
    await advance(6_000)
    expect(sequences(first.text())).toEqual([4, 5, 6, 7])
    const lastCursor = [...first.text().matchAll(/^id: (.+)$/gm)].at(-1)![1]!
    first.abort.abort()
    await flush()

    // Events land while the client is away; it reconnects with the cursor it holds.
    ctl.head = 12
    const decoded = await decodeWorkspaceEventCursor(lastCursor, workspaceId)
    expect(decoded.ok && decoded.cursor.sequence).toBe(7)
    const second = await connect(workspaceId, lastCursor)
    await advance(2_000)
    expect(sequences(second.text())).toEqual([8, 9, 10, 11, 12])
  })
})
