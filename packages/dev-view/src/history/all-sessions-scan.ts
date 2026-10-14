/*
 * Bounded read of the sessions a workspace-wide History search covers (#716).
 * There is no server-side search and no second store: the scan lists the
 * workspace's open sessions and runs, then reads the retained event window of
 * the most recently active sessions through the same read-only
 * `runtime-events-v1` stream the bound-session feed uses, a few at a time, and
 * closes every stream as soon as its window is read. What it could not cover is
 * reported as `partial`, never implied to be searched.
 */
import type { HarnessRun, RuntimeEvent, RuntimeSession } from '@adea-ai/types/dev-runtime'

import type { RuntimeEventStream } from '../chat/model/event-stream'
import { transcriptIsStale } from './turns-model'

/** Sessions whose event window is read; older ones are reported as not searched. */
export const SCAN_MAX_SESSIONS = 20
const SCAN_CONCURRENCY = 4
const LIST_MAX_PAGES = 3
const RUN_MAX_PAGES = 2

export type SessionWindow = Readonly<{
  events: readonly RuntimeEvent[]
  /** Older events are missing: retention cut the window, or the replay was still running at the timeout. */
  bounded: boolean
}>

type Page<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>

export type AllSessionsScanIO = Readonly<{
  listSessions: (cursor: string | undefined) => Promise<Page<RuntimeSession>>
  listRuns: (cursor: string | undefined) => Promise<Page<HarnessRun>>
  /** Resolves undefined when the window could not be read in full. */
  readWindow: (session: RuntimeSession) => Promise<SessionWindow | undefined>
  /** Throws when the scope changed in flight; the result is then discarded. */
  assertCurrent: () => void
}>

export type AllSessionsScan = Readonly<{
  sessions: readonly RuntimeSession[]
  runs: readonly HarnessRun[]
  events: ReadonlyMap<string, readonly RuntimeEvent[]>
  /** Sessions whose event window was read. */
  searched: number
  /** Something older or beyond the bounds was not searched. */
  partial: boolean
  scannedAt: number
}>

async function allPages<T>(
  read: (cursor: string | undefined) => Promise<Page<T>>,
  maxPages: number
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const result = await read(cursor)
    items.push(...result.items)
    if (result.nextCursor === undefined) return { items, truncated: false }
    // A repeated cursor would loop forever; stop and say the list is cut short.
    if (seen.has(result.nextCursor)) return { items, truncated: true }
    seen.add(result.nextCursor)
    cursor = result.nextCursor
  }
  return { items, truncated: true }
}

export async function scanAllSessions(
  io: AllSessionsScanIO,
  now: () => number = Date.now
): Promise<AllSessionsScan> {
  const listed = await allPages((cursor) => io.listSessions(cursor), LIST_MAX_PAGES)
  io.assertCurrent()
  // Runs are optional context (resume, recency). A runtime without run read
  // access still searches prompts and replies.
  const runPages = await allPages((cursor) => io.listRuns(cursor), RUN_MAX_PAGES).catch(() => {
    io.assertCurrent()
    return { items: [] as HarnessRun[], truncated: false }
  })
  io.assertCurrent()
  const lastRun = new Map<string, string>()
  for (const run of runPages.items) {
    const at = run.startedAt ?? ''
    if (at > (lastRun.get(run.runtimeSessionId) ?? '')) lastRun.set(run.runtimeSessionId, at)
  }
  // Recent activity first; sessions with no run keep the runtime's list order.
  const candidates = listed.items
    .filter((session) => !session.archived && session.projection !== 'terminal_fallback')
    .map((session, index) => ({ session, index }))
    .toSorted(
      (left, right) =>
        (lastRun.get(right.session.id) ?? '').localeCompare(lastRun.get(left.session.id) ?? '') ||
        left.index - right.index
    )
    .map(({ session }) => session)
  const targets = candidates.slice(0, SCAN_MAX_SESSIONS)

  const events = new Map<string, readonly RuntimeEvent[]>()
  let unread = 0
  let bounded = false
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const session = targets[next++]!
      let window: SessionWindow | undefined
      try {
        window = await io.readWindow(session)
      } catch {
        io.assertCurrent()
        window = undefined
      }
      io.assertCurrent()
      if (!window) unread += 1
      else {
        events.set(session.id, window.events)
        if (window.bounded) bounded = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, targets.length) }, worker))
  io.assertCurrent()
  if (targets.length > 0 && events.size === 0) throw new Error('No session history could be read.')
  return {
    sessions: listed.items,
    runs: runPages.items,
    events,
    searched: events.size,
    partial:
      listed.truncated ||
      runPages.truncated ||
      candidates.length > targets.length ||
      unread > 0 ||
      bounded,
    scannedAt: now(),
  }
}

type Timers = Readonly<{
  /** Quiet time after the last frame that marks the replay as finished. */
  quietMs?: number
  /** Longest wait for one session before its window is taken as it stands. */
  timeoutMs?: number
}>

/**
 * Read a freshly opened event stream to the end of its replay. The stream is a
 * live tail with no end marker, so a window is complete once frames stop
 * arriving after the opening frame; a stream that never opens is unread.
 */
export function readEventWindow(
  stream: RuntimeEventStream,
  timers: Timers = {}
): Promise<SessionWindow | undefined> {
  const quietMs = timers.quietMs ?? 300
  const timeoutMs = timers.timeoutMs ?? 4_000
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined
    let hard: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    let done = false
    const finish = (readable: boolean, replaying = false) => {
      if (done) return
      done = true
      clearTimeout(quiet)
      clearTimeout(hard)
      unsubscribe?.()
      stream.close()
      const state = stream.state()
      resolve(
        readable && !transcriptIsStale(state.availability)
          ? { events: state.events, bounded: replaying || !state.retention.complete }
          : undefined
      )
    }
    const opened = () => stream.state().expectedSequence !== undefined
    const observe = () => {
      if (transcriptIsStale(stream.state().availability)) return finish(false)
      if (!opened()) return
      clearTimeout(quiet)
      quiet = setTimeout(() => finish(true), quietMs)
    }
    unsubscribe = stream.subscribe(observe)
    // Still receiving frames at the timeout: what arrived is kept, as partial.
    hard = setTimeout(() => finish(opened(), true), timeoutMs)
    observe()
  })
}
