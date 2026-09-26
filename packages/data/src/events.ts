import type { QueryClient } from '@tanstack/solid-query'

import {
  agentQueryKeys,
  artifactQueryKeys,
  channelQueryKeys,
  readStateQueryKeys,
  roomQueryKeys,
  taskQueryKeys,
} from './index'

/**
 * Client for the durable workspace event stream.
 *
 * The stream carries committed WorkspaceEvents; this client's job is to turn
 * them into cache refreshes without becoming a second store. It applies events
 * by sequence, ignores anything it has already seen (delivery may duplicate),
 * refreshes only the query groups the event names, and treats a gap or an
 * explicit `resync_required` as a demand to refetch authoritative current state
 * rather than to keep going with uncertain data.
 *
 * Transport is `fetch` plus a small SSE parser rather than `EventSource`, so
 * both cookie-authenticated web sessions and bearer-authenticated desktop
 * sessions use one path, and the client can carry its cursor explicitly.
 */

export type WorkspaceEventEnvelope = Readonly<{
  aggregateId: string | null
  aggregateType: string
  actor: Readonly<{ id: string; kind: string }> | null
  eventId: string
  eventType: string
  occurredAt: string
  payload: Record<string, unknown>
  schemaVersion: number
  workspaceSequence: number
}>

/** Cursor storage so a reload resumes where the previous session stopped. */
export type CursorStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>

export type WorkspaceEventSubscriptionOptions = Readonly<{
  workspaceId: string
  /** Absolute stream URL, e.g. `${origin}/api/v1/workspaces/${id}/events`. */
  url: string
  queryClient: QueryClient
  /** Extra request headers, used by the desktop shell for its bearer session. */
  headers?: () => Record<string, string>
  fetchImpl?: typeof fetch
  storage?: CursorStorage
  /** Delay source for tests and for deterministic backoff assertions. */
  schedule?: (run: () => void, delayMs: number) => () => void
  now?: () => number
  random?: () => number
  onDiagnostic?: (diagnostic: WorkspaceEventDiagnostic) => void
}>

export type WorkspaceEventDiagnostic = Readonly<{
  cursorSequence: number
  event: 'connected' | 'disconnected' | 'gap' | 'resync' | 'applied'
  reason?: string
}>

export type WorkspaceEventSubscription = Readonly<{
  /** Latest applied workspace sequence; 0 before the first event. */
  appliedSequence(): number
  /** Force a reconnect that replays from the stored cursor. */
  reconnect(): void
  stop(): void
}>

export const INITIAL_RECONNECT_DELAY_MS = 1_000
export const MAX_RECONNECT_DELAY_MS = 30_000
/** A connection that stays up this long is considered stable and resets backoff. */
export const STABLE_CONNECTION_MS = 10_000

/** Query groups one event type invalidates. Prefix matching keeps it total. */
export function queryKeysForEvent(
  workspaceId: string,
  eventType: string
): readonly (readonly unknown[])[] {
  const [family = ''] = eventType.split('.')
  switch (family) {
    case 'message':
      // A message can reopen its Task and change read state, so those refresh
      // with it; the message groups themselves cover every channel the client
      // has open.
      return [
        ['workspaces', workspaceId, 'messages'],
        ['workspaces', workspaceId, 'channels'],
        readStateQueryKeys.detail(workspaceId),
        taskQueryKeys.all(workspaceId),
      ]
    case 'channel':
      return [
        channelQueryKeys.all(workspaceId),
        readStateQueryKeys.detail(workspaceId),
        roomQueryKeys.all(workspaceId),
      ]
    case 'thread':
      return [readStateQueryKeys.detail(workspaceId), channelQueryKeys.all(workspaceId)]
    case 'room':
      return [roomQueryKeys.all(workspaceId), channelQueryKeys.all(workspaceId)]
    case 'agent':
      return [agentQueryKeys.all(workspaceId)]
    case 'artifact':
      return [artifactQueryKeys.all(workspaceId), taskQueryKeys.all(workspaceId)]
    case 'content':
      return [artifactQueryKeys.all(workspaceId)]
    case 'task':
      return [taskQueryKeys.all(workspaceId)]
    case 'workspace':
      return [['workspaces', workspaceId]]
    default:
      // Unknown families refresh the workspace scope rather than being dropped.
      return [['workspaces', workspaceId]]
  }
}

/** Everything a resync must refresh: the authoritative current state. */
export function workspaceScopeKeys(workspaceId: string): readonly (readonly unknown[])[] {
  return [['workspaces', workspaceId]]
}

/** Backoff schedule: exponential to the cap, with jitter supplied by the caller. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    MAX_RECONNECT_DELAY_MS
  )
  // Full jitter keeps a fleet of clients from reconnecting in lockstep.
  return Math.round(exponential / 2 + random() * (exponential / 2))
}

/** Parse one `key: value` SSE line pair set into the fields this client uses. */
export function parseEventFrames(chunk: string): ReadonlyArray<{
  data: string
  event: string
  id: string | null
  retryMs: number | null
}> {
  // Only terminated frames count: a partial frame stays in the caller's buffer
  // until its terminating blank line arrives.
  const boundary = chunk.lastIndexOf('\n\n')
  if (boundary === -1) return []
  const frames = []
  for (const block of chunk.slice(0, boundary).split('\n\n')) {
    const lines = block.split('\n')
    let data = ''
    let event = 'message'
    let id: string | null = null
    let retryMs: number | null = null
    for (const line of lines) {
      if (line.startsWith(':')) continue
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      const field = line.slice(0, separator)
      const value = line.slice(separator + 1).trimStart()
      if (field === 'data') data = data ? `${data}\n${value}` : value
      else if (field === 'event') event = value
      else if (field === 'id') id = value
      else if (field === 'retry') {
        const parsed = Number(value)
        retryMs = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
      }
    }
    if (data.length > 0 || retryMs !== null) frames.push({ data, event, id, retryMs })
  }
  return frames
}

/**
 * Subscribe to a workspace's durable event stream. Returns a subscription whose
 * cursor persistence, dedupe, gap detection, and backoff all live here rather
 * than in the UI.
 */
export function createWorkspaceEventSubscription(
  options: WorkspaceEventSubscriptionOptions
): WorkspaceEventSubscription {
  const {
    fetchImpl = fetch,
    headers,
    queryClient,
    schedule = (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
    storage,
    url,
    workspaceId,
  } = options
  const now = options.now ?? (() => Date.now())
  const cursorKey = `adea:workspace-events-cursor:${workspaceId}`
  // The replay cursor is the server's opaque, HMAC-signed token from the frame's
  // `id:` — NOT the event sequence. The two are tracked separately: the token
  // is what the route accepts on reconnect, the sequence is what gap detection
  // compares. Storing the sequence and sending it back as `?cursor=<n>` made
  // every reconnect fail server-side as `cursor-malformed`, so the retained
  // window was never replayed and every reconnect became a full resync.
  const cursorTokenKey = `adea:workspace-events-resume:${workspaceId}`

  let stopped = false
  let controller: AbortController | undefined
  let cancelRetry: (() => void) | undefined
  let attempt = 0
  let appliedSequence = readCursor()
  let serverRetryMs: number | null = null
  let inFlight = false

  function readCursor(): number {
    // Reads are as failure-tolerant as the writes below: a `Storage` that
    // throws on `getItem` (storage disabled by policy, a revoked quota) used to
    // throw during construction, taking the whole subscription with it.
    let stored: string | null = null
    try {
      stored = storage?.getItem(cursorKey) ?? null
    } catch {
      stored = null
    }
    const parsed = stored ? Number(stored) : 0
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
  }

  /** The signed token to present on reconnect, or '' when none was ever sent. */
  function readCursorToken(): string {
    let stored: string | null = null
    try {
      stored = storage?.getItem(cursorTokenKey) ?? null
    } catch {
      stored = null
    }
    // A cursor is a `base64url(payload).base64url(signature)` pair. Reject
    // anything else rather than presenting a value the route must refuse.
    return stored && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(stored) ? stored : ''
  }

  let resumeCursor = readCursorToken()

  function persistCursorToken(token: string): void {
    if (!token) return
    resumeCursor = token
    try {
      storage?.setItem(cursorTokenKey, token)
    } catch {
      // Persistence is best effort: private modes and quotas skip it.
    }
  }

  function persistCursor(sequence: number): void {
    appliedSequence = sequence
    try {
      storage?.setItem(cursorKey, String(sequence))
    } catch {
      // Persistence is best effort: private modes and quotas skip it.
    }
  }

  // Refreshes are queued, deduplicated by key, and flushed once per stream
  // chunk: a burst of events in one read maps to the same few query groups, and
  // invalidating them per event would turn N messages into N×groups refetches.
  let pendingRefresh: Map<string, readonly unknown[]> | undefined

  function refresh(keys: readonly (readonly unknown[])[]): void {
    for (const key of keys) {
      ;(pendingRefresh ??= new Map()).set(JSON.stringify(key), key)
    }
  }

  function flushRefresh(): void {
    if (!pendingRefresh?.size) return
    const keys = [...pendingRefresh.values()]
    pendingRefresh = undefined
    for (const key of keys) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }

  function resync(reason: string): void {
    // Current state is authoritative; a resync refetches it instead of guessing
    // from a stream that cannot prove continuity.
    diagnostics('resync', reason)
    refresh(workspaceScopeKeys(workspaceId))
  }

  function diagnostics(event: WorkspaceEventDiagnostic['event'], reason?: string): void {
    options.onDiagnostic?.({
      cursorSequence: appliedSequence,
      event,
      ...(reason ? { reason } : {}),
    })
  }

  function applyEvent(envelope: WorkspaceEventEnvelope): void {
    if (envelope.workspaceSequence <= appliedSequence) {
      // Duplicate delivery, or a replay of something already applied.
      return
    }
    if (envelope.workspaceSequence > appliedSequence + 1 && appliedSequence > 0) {
      // A gap means an event was missed; refreshing authoritative state is the
      // only safe recovery, and the cursor still advances so the stream resumes.
      persistCursor(envelope.workspaceSequence)
      diagnostics('gap', `missing ${envelope.workspaceSequence - appliedSequence - 1}`)
      refresh(workspaceScopeKeys(workspaceId))
      return
    }
    persistCursor(envelope.workspaceSequence)
    diagnostics('applied')
    refresh(queryKeysForEvent(workspaceId, envelope.eventType))
  }

  function handleFrame(frame: {
    data: string
    event: string
    id: string | null
    retryMs: number | null
  }): void {
    if (frame.retryMs !== null) serverRetryMs = frame.retryMs
    if (frame.event === 'resync_required') {
      // The server mints a FRESH signed cursor on the resync frame precisely so
      // the client can resume from the new position. Dropping it meant the
      // client re-presented the very token the server had just rejected, so an
      // expired or out-of-window cursor produced a resync on every reconnect,
      // forever — the exact failure the cursor fix was meant to end.
      if (frame.id) persistCursorToken(frame.id)
      resync('server')
      return
    }
    if (frame.event === 'stream_unavailable') {
      // The server is draining or the membership changed: reconnect through the
      // normal path so authorization is re-checked.
      throw new StreamUnavailable(frame.data)
    }
    if (frame.event !== 'workspace.event') return
    // The frame's `id:` is the signed replay cursor. Record it before applying
    // so a drop between the two still resumes from a position the route
    // accepts; replaying one already-applied event is harmless because the
    // client discards sequences it has seen (`workspaceSequence <= applied`).
    if (frame.id) persistCursorToken(frame.id)
    try {
      applyEvent(JSON.parse(frame.data) as WorkspaceEventEnvelope)
    } catch {
      // A frame this client cannot parse is not authoritative state; the next
      // reconnect replays it.
    }
  }

  async function connect(): Promise<void> {
    controller = new AbortController()
    const signal = controller.signal
    const cursor = resumeCursor
    // The stream URL may be relative (same-origin web) or absolute (desktop
    // against the cloud origin), so the cursor is appended rather than parsed
    // through URL(): a relative path is not a valid absolute URL in a browser.
    const target = cursor
      ? `${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
      : url

    let connectedAt = 0
    try {
      const response = await fetchImpl(target, {
        headers: { accept: 'text/event-stream', ...headers?.() },
        signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`workspace event stream unavailable: ${response.status}`)
      }
      connectedAt = now()
      diagnostics('connected')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Frames are separated by a blank line; keep the trailing partial frame.
        const boundary = buffer.lastIndexOf('\n\n')
        if (boundary === -1) continue
        const chunk = buffer.slice(0, boundary + 2)
        buffer = buffer.slice(boundary + 2)
        for (const frame of parseEventFrames(chunk)) handleFrame(frame)
        flushRefresh()
      }
    } catch {
      // Falls through to the reconnect schedule below.
    } finally {
      // Anything queued before the stream dropped still applies: the cursor
      // for those events was already persisted.
      flushRefresh()
      if (connectedAt > 0 && now() - connectedAt >= STABLE_CONNECTION_MS) attempt = 0
      diagnostics('disconnected')
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return
    attempt += 1
    const delay = reconnectDelay(attempt, options.random ?? Math.random)
    // The server's retry hint is a floor: never reconnect faster than it asks.
    cancelRetry = schedule(() => void run(), Math.max(delay, serverRetryMs ?? 0))
  }

  async function run(): Promise<void> {
    if (stopped) return
    // One stream at a time. `reconnect()` aborts the in-flight run, whose
    // `finally` would otherwise schedule a second reconnect on top of the new
    // one — two live subscriptions, both receiving events.
    if (inFlight) return
    inFlight = true
    try {
      await connect()
    } finally {
      inFlight = false
    }
    scheduleReconnect()
  }

  void run()

  return {
    appliedSequence: () => appliedSequence,
    reconnect() {
      if (stopped) return
      cancelRetry?.()
      controller?.abort()
      void run()
    },
    stop() {
      stopped = true
      cancelRetry?.()
      controller?.abort()
    },
  }
}

class StreamUnavailable extends Error {}
