import type { Scope } from '@adea-ai/types/dev-runtime'
import {
  decodeRuntimeEventHistoryPage,
  type RuntimeEventHistoryPage,
} from '@adea-ai/types/dev-runtime-history'
import { buildDevCommand } from '../../browser/command'
import type { DevRuntimeService } from '../../platform'
import { ChatRuntimeError, executeChatCommand } from './commands'
import { CHAT_EVENT_RETENTION_LIMIT, type TranscriptAccumulator } from './transcript'

function invalid(
  code: 'identity_mismatch' | 'resync_required' | 'idempotency_conflict',
  message: string
): never {
  throw new ChatRuntimeError({ code, message, retryable: code === 'resync_required' })
}

export async function readRuntimeEventHistory(input: {
  service: DevRuntimeService
  scope: Scope
  runtimeSessionId: string
  generation: number
  beforeSequence?: string
  cursor?: string
  limit?: number
}): Promise<RuntimeEventHistoryPage> {
  const value = await executeChatCommand<unknown>(
    input.service,
    buildDevCommand({
      operation: 'dev.session.history',
      scope: input.scope,
      resource: {
        kind: 'runtime_session',
        id: input.runtimeSessionId,
        generation: input.generation,
      },
      body: {
        runtimeSessionId: input.runtimeSessionId,
        expectedGeneration: input.generation,
        ...(input.beforeSequence !== undefined ? { beforeSequence: input.beforeSequence } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    })
  )
  const page = decodeRuntimeEventHistoryPage(value)
  if (
    page.runtimeSessionId !== input.runtimeSessionId ||
    page.generation !== input.generation ||
    (input.beforeSequence !== undefined && page.beforeSequence !== input.beforeSequence)
  )
    invalid('identity_mismatch', 'Transcript history does not match the requested session window.')
  return page
}

/** Backfill does not advance the live stream's acknowledgement/replay cursor. */
export function prependRuntimeHistory(
  state: TranscriptAccumulator,
  value: RuntimeEventHistoryPage
): TranscriptAccumulator {
  const page = decodeRuntimeEventHistoryPage(value)
  if (page.runtimeSessionId !== state.runtimeSessionId || page.generation !== state.generation)
    invalid('identity_mismatch', 'Transcript history belongs to another session generation.')
  if (['conflict', 'resync_required', 'stale_generation'].includes(state.availability.status))
    invalid('resync_required', 'Reattach the transcript before loading older history.')
  const merged = [...state.events]
  for (const event of page.items) {
    const existing = merged.find(
      (entry) =>
        entry.seq === event.seq ||
        (entry.source === event.source && entry.sourceEventId === event.sourceEventId)
    )
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event))
        invalid('idempotency_conflict', 'Transcript history conflicts with an accepted event.')
    } else merged.push(event)
  }
  merged.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
  for (let i = 1; i < merged.length; i++)
    if (BigInt(merged[i]!.seq) !== BigInt(merged[i - 1]!.seq) + 1n)
      invalid('resync_required', 'Transcript history has an unexplained gap.')
  const events = merged.slice(-CHAT_EVENT_RETENTION_LIMIT)
  const oldestSequence = events[0]?.seq
  const newestSequence = events.at(-1)?.seq
  const complete =
    page.historyStart === 'generation_start' &&
    page.nextCursor === undefined &&
    oldestSequence === '1'
  return {
    ...state,
    ...(page.retainedFromSequence === null || page.retainedFromSequence === undefined
      ? {}
      : {
          retainedFloorSequence:
            state.retainedFloorSequence === undefined ||
            BigInt(page.retainedFromSequence) > BigInt(state.retainedFloorSequence)
              ? page.retainedFromSequence
              : state.retainedFloorSequence,
        }),
    events,
    availability: complete
      ? { status: 'available' }
      : {
          status: 'bounded',
          reason: page.nextCursor ? 'checkpoint_required' : 'retention',
          ...(oldestSequence ? { oldestSequence } : {}),
        },
    retention: {
      maxEvents: CHAT_EVENT_RETENTION_LIMIT,
      complete,
      ...(oldestSequence ? { oldestSequence } : {}),
      ...(newestSequence ? { newestSequence } : {}),
      ...(!complete
        ? { reason: page.nextCursor ? ('checkpoint_required' as const) : ('retention' as const) }
        : {}),
    },
  }
}

/** One mounted session's history request lifetime; shared UI owns scroll anchoring. */
export function createRuntimeHistoryLoader(input: {
  state: () => TranscriptAccumulator
  commit: (state: TranscriptAccumulator) => void
  read: (options: { beforeSequence?: string; cursor?: string }) => Promise<RuntimeEventHistoryPage>
}) {
  const lifetime = new AbortController()
  let pending: Promise<void> | undefined
  let cursor: string | null | undefined
  let cursorAnchor: string | undefined
  const hasOlder = () => {
    const state = input.state()
    const oldest = state.events[0]?.seq
    const floor = state.retainedFloorSequence
    return (
      !lifetime.signal.aborted &&
      cursor !== null &&
      !['conflict', 'resync_required', 'stale_generation'].includes(state.availability.status) &&
      state.events.length < CHAT_EVENT_RETENTION_LIMIT &&
      BigInt(oldest ?? '0') > 1n &&
      (floor === undefined || BigInt(oldest ?? '0') > BigInt(floor))
    )
  }
  function loadOlder(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (options.signal?.aborted)
      return Promise.reject(new DOMException('Transcript history load cancelled.', 'AbortError'))
    if (pending) return pending
    if (!hasOlder()) return Promise.resolve()
    const signal = options.signal
      ? AbortSignal.any([lifetime.signal, options.signal])
      : lifetime.signal
    if (signal.aborted)
      return Promise.reject(new DOMException('Transcript history load cancelled.', 'AbortError'))
    const mounted = input.state()
    const beforeSequence = mounted.events[0]!.seq
    const request = cursor && cursorAnchor === beforeSequence ? { cursor } : { beforeSequence }
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Transcript history load cancelled.', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
    })
    let response: Promise<RuntimeEventHistoryPage>
    try {
      response = input.read(request)
    } catch (error) {
      signal.removeEventListener('abort', abort)
      return Promise.reject(error)
    }
    const task = Promise.race([response, cancelled])
      .then((page) => {
        if (signal.aborted)
          throw new DOMException('Transcript history load cancelled.', 'AbortError')
        const current = input.state()
        if (
          current.runtimeSessionId !== mounted.runtimeSessionId ||
          current.generation !== mounted.generation
        )
          invalid('identity_mismatch', 'The mounted transcript changed during history loading.')
        if (page.beforeSequence !== beforeSequence)
          invalid('identity_mismatch', 'Transcript history changed its insertion anchor.')
        const next = prependRuntimeHistory(current, page)
        input.commit(next)
        cursor = page.nextCursor ?? null
        cursorAnchor = next.events[0]?.seq
      })
      .finally(() => {
        signal.removeEventListener('abort', abort)
        if (pending === task) pending = undefined
      })
    pending = task
    return task
  }
  return { loadOlder, hasOlder, close: () => lifetime.abort() }
}
