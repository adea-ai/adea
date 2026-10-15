import { createHash } from 'node:crypto'
import {
  decodeFollowUpQueueEventPayload,
  decodeFollowUpQueueRequest,
  decodeFollowUpQueueSnapshot,
  FOLLOW_UP_QUEUE_MAX_BYTES,
  FOLLOW_UP_QUEUE_MAX_ITEMS,
  type FollowUpQueueEventPayload,
  type FollowUpQueueItem,
  type FollowUpQueueRequest,
  type FollowUpQueueSnapshot,
  type FollowUpDeliveryReceipt,
} from '../../../../../../packages/types/src/dev-runtime-follow-ups'
import type { HarnessRunState, Scope } from '../../../../../../packages/types/src/dev-runtime'
import type { DevErrorCode } from '../../../../../../packages/types/src/dev-runtime-errors'
import { createFollowUpStorage } from './follow-up-storage'

export type FollowUpLiveState = Readonly<{
  generation: number
  archived: boolean
  runId?: string
  runVersion?: number
  state?: HarnessRunState
  deliverySupported: boolean
  /** Actual structured connection identity/generation, when one is bound. */
  deliveryBinding?: string
}>
type State = {
  schemaVersion: 1
  runtimeSessionId: string
  generation: number
  version: number
  items: FollowUpQueueItem[]
  seenIds: string[]
  operations: { key: string; digest: string }[]
  lastWindow?: { runId: string; version: number }
  lastDelivery?: FollowUpDeliveryReceipt
  outbox?: FollowUpQueueEventPayload
  stopped: boolean
}
type Authorization = { idempotencyKey?: string; authorize: () => Promise<() => void> }
type Attempt = {
  attempt: true
  request: FollowUpQueueRequest
  item: FollowUpQueueItem
  live: FollowUpLiveState
  fence: () => void
}
function error(code: DevErrorCode, message: string): never {
  throw { code, retryable: false, message }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function createFollowUpQueue(input: {
  dataDir: string
  scope: Scope
  key?: () => Buffer
  resolve: (runtimeSessionId: string) => FollowUpLiveState
  publish: (event: FollowUpQueueEventPayload) => void
  deliver?: (input: {
    runtimeSessionId: string
    generation: number
    runId: string
    messageId: string
    text: string
    signal: AbortSignal
    deliveryBinding?: string
  }) => Promise<{ ok: boolean }>
  deliveryTimeoutMs?: number
}) {
  const storage = createFollowUpStorage(input)
  const inFlight = new Map<string, AbortController>()
  function empty(runtimeSessionId: string, generation: number): State {
    return {
      schemaVersion: 1,
      runtimeSessionId,
      generation,
      version: 0,
      items: [],
      seenIds: [],
      operations: [],
      stopped: false,
    }
  }
  function liveFor(
    request: Pick<FollowUpQueueRequest, 'runtimeSessionId' | 'expectedGeneration'>
  ): FollowUpLiveState {
    const live = input.resolve(request.runtimeSessionId)
    if (live.generation !== request.expectedGeneration)
      error('stale_generation', 'follow-up queue generation changed')
    if (
      live.runVersion !== undefined &&
      (!Number.isSafeInteger(live.runVersion) || live.runVersion < 0)
    )
      error('corrupt_state', 'follow-up run version is not valid')
    return live
  }
  function view(state: State, live: FollowUpLiveState): FollowUpQueueSnapshot {
    const alreadyUsed =
      state.lastWindow?.runId === live.runId && state.lastWindow?.version === live.runVersion
    const delivery =
      !input.deliver || !live.deliverySupported
        ? 'unavailable'
        : !state.stopped &&
            !live.archived &&
            live.state === 'awaiting_input' &&
            !alreadyUsed &&
            state.items.every((item) => item.state === 'queued')
          ? 'ready'
          : 'busy'
    return decodeFollowUpQueueSnapshot({
      schemaVersion: 1,
      runtimeSessionId: state.runtimeSessionId,
      generation: state.generation,
      version: state.version,
      delivery,
      items: state.items,
      ...(state.lastDelivery ? { lastDelivery: state.lastDelivery } : {}),
    })
  }
  function load(sessionId: string): State | undefined {
    const value = storage.load(sessionId)
    if (value === undefined) return undefined
    try {
      const state = value as State
      const allowed = new Set([
        'schemaVersion',
        'runtimeSessionId',
        'generation',
        'version',
        'items',
        'seenIds',
        'operations',
        'lastWindow',
        'lastDelivery',
        'outbox',
        'stopped',
      ])
      if (
        !state ||
        typeof state !== 'object' ||
        Object.keys(state).some((key) => !allowed.has(key)) ||
        state.runtimeSessionId !== sessionId ||
        typeof state.stopped !== 'boolean'
      )
        throw new Error()
      decodeFollowUpQueueSnapshot({
        schemaVersion: state.schemaVersion,
        runtimeSessionId: state.runtimeSessionId,
        generation: state.generation,
        version: state.version,
        delivery: 'unavailable',
        items: state.items,
        ...(state.lastDelivery ? { lastDelivery: state.lastDelivery } : {}),
      })
      if (
        !Array.isArray(state.seenIds) ||
        state.seenIds.length > 256 ||
        new Set(state.seenIds).size !== state.seenIds.length ||
        state.seenIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 128)
      )
        throw new Error()
      if (
        !Array.isArray(state.operations) ||
        state.operations.length > 1024 ||
        new Set(state.operations.map((op) => op.key)).size !== state.operations.length ||
        state.operations.some(
          (op) =>
            typeof op.key !== 'string' ||
            op.key.length < 1 ||
            op.key.length > 128 ||
            typeof op.digest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(op.digest)
        )
      )
        throw new Error()
      if (state.outbox) decodeFollowUpQueueEventPayload(state.outbox)
      if (
        state.lastWindow &&
        (typeof state.lastWindow.runId !== 'string' ||
          !Number.isSafeInteger(state.lastWindow.version) ||
          state.lastWindow.version < 0)
      )
        throw new Error()
      return state
    } catch {
      return error('corrupt_state', 'follow-up queue state requires recovery')
    }
  }
  function save(state: State): void {
    storage.save(state.runtimeSessionId, state.generation, state)
  }
  function flush(state: State): void {
    if (!state.outbox) return
    input.publish(state.outbox)
    delete state.outbox
    save(state)
  }
  function publish(state: State, change: FollowUpQueueEventPayload['change']): void {
    state.version += 1
    state.outbox = decodeFollowUpQueueEventPayload({
      schemaVersion: 1,
      runtimeSessionId: state.runtimeSessionId,
      generation: state.generation,
      version: state.version,
      items: state.items.map(({ text: _text, ...item }) => item),
      change,
      ...(state.lastDelivery ? { lastDelivery: state.lastDelivery } : {}),
    })
    save(state)
    flush(state)
  }
  async function execute(
    raw: FollowUpQueueRequest,
    authorization: Authorization
  ): Promise<FollowUpQueueSnapshot> {
    const request = decodeFollowUpQueueRequest(raw)
    let releaseDeliveryClaim: (() => void) | undefined
    const result = storage.locked(async (): Promise<FollowUpQueueSnapshot | Attempt> => {
      const fence = await authorization.authorize()
      fence()
      const live = liveFor(request)
      let state = load(request.runtimeSessionId)
      if (state) flush(state)
      if (state && state.generation > request.expectedGeneration)
        error('stale_generation', 'a newer follow-up generation is already retained')
      if (!state || state.generation !== request.expectedGeneration) {
        state = empty(request.runtimeSessionId, request.expectedGeneration)
        save(state)
      }
      const abandoned = state.items.findIndex((item) => item.state === 'dispatching')
      if (abandoned >= 0) {
        // Acquire rather than infer liveness from a persisted item or this
        // instance's in-memory map. A peer's real transport call holds this
        // cross-process lock until its receipt is finalized.
        const release = await storage.tryDeliveryClaim(request.runtimeSessionId)
        if (release) {
          try {
            fence()
            liveFor(request)
            const item = state.items[abandoned]!
            state.items[abandoned] = { ...item, state: 'ambiguous' }
            state.lastDelivery = { messageId: item.id, status: 'ambiguous' }
            publish(state, 'delivery_ambiguous')
          } finally {
            release()
          }
        }
      }
      if (request.action === 'read') return view(state, live)
      if (live.archived || state.stopped) error('invalid_state', 'follow-up queue is not active')
      const key = authorization.idempotencyKey
      if (!key || key.length > 128)
        error('invalid_state', 'follow-up mutation requires an idempotency key')
      const digest = hash({
        action: request.action,
        runtimeSessionId: request.runtimeSessionId,
        generation: request.expectedGeneration,
        version: request.expectedVersion,
        ...('messageId' in request ? { messageId: request.messageId } : {}),
        ...('text' in request ? { text: request.text } : {}),
        ...('messageIds' in request ? { messageIds: request.messageIds } : {}),
      })
      const prior = state.operations.find((entry) => entry.key === key)
      if (prior) {
        if (prior.digest !== digest)
          error('idempotency_conflict', 'follow-up idempotency key has another request')
        return view(state, live)
      }
      if (state.version !== request.expectedVersion)
        error('stale_version', 'follow-up queue version changed')
      if (state.operations.length >= 1024)
        error('limit_exceeded', 'follow-up mutation limit reached for this generation')
      if (request.action === 'enqueue') {
        if (!live.runId) error('invalid_state', 'follow-ups require a live harness run')
        if (state.seenIds.includes(request.messageId))
          error('idempotency_conflict', 'follow-up message identity was already used')
        const bytes = new TextEncoder().encode(request.text).byteLength
        if (
          state.items.length >= FOLLOW_UP_QUEUE_MAX_ITEMS ||
          state.seenIds.length >= 256 ||
          state.items.reduce((sum, item) => sum + item.bytes, 0) + bytes > FOLLOW_UP_QUEUE_MAX_BYTES
        )
          error('limit_exceeded', 'follow-up queue limit reached')
        state.items.push({ id: request.messageId, text: request.text, bytes, state: 'queued' })
        state.seenIds.push(request.messageId)
      } else if (request.action === 'remove') {
        const removed = state.items.find((item) => item.id === request.messageId)
        if (!removed) error('not_found', 'follow-up message not found')
        if (removed.state === 'dispatching')
          error('invalid_state', 'an in-flight follow-up cannot be removed')
        state.items = state.items.filter((item) => item.id !== request.messageId)
      } else if (request.action === 'reorder') {
        if (state.items.some((item) => item.state !== 'queued'))
          error('invalid_state', 'claimed follow-ups cannot be reordered')
        if (
          request.messageIds.length !== state.items.length ||
          request.messageIds.some((id) => !state.items.some((item) => item.id === id))
        )
          error('invalid_state', 'reorder must name every queued message exactly once')
        state.items = request.messageIds.map((id) => state!.items.find((item) => item.id === id)!)
      } else {
        if (!input.deliver || !live.deliverySupported)
          error('capability_unavailable', 'structured follow-up delivery is unavailable')
        if (state.items.some((item) => item.state !== 'queued'))
          error('delivery_ambiguous', 'a prior delivery claim must be resolved without retrying it')
        if (view(state, live).delivery !== 'ready' || !live.runId || live.runVersion === undefined)
          error('invalid_state', 'follow-up delivery requires a fresh observed input boundary')
        const item = state.items[0]
        if (!item) error('not_found', 'follow-up queue is empty')
        releaseDeliveryClaim = await storage.tryDeliveryClaim(request.runtimeSessionId)
        if (!releaseDeliveryClaim)
          error('invalid_state', 'another follow-up delivery is still active')
        fence()
        liveFor(request)
        state.items[0] = { ...item, state: 'dispatching' }
        state.lastWindow = { runId: live.runId, version: live.runVersion }
        state.operations.push({ key, digest })
        // Persist the claim before handing text to any transport. A crash here
        // is intentionally ambiguous and never causes a blind retry.
        publish(state, 'delivery_started')
        return { attempt: true, request, item, live, fence }
      }
      fence()
      liveFor(request)
      state.operations.push({ key, digest })
      publish(state, request.action)
      return view(state, live)
    })
    return result
      .then((value) => ('attempt' in value ? finishDelivery(value) : value))
      .finally(() => {
        // Also release when publishing a durable claim failed before handoff.
        releaseDeliveryClaim?.()
      })
  }

  async function finishDelivery(attempt: Attempt): Promise<FollowUpQueueSnapshot> {
    const { request, item, fence } = attempt
    const controller = new AbortController()
    const flightKey = `${request.runtimeSessionId}:${request.expectedGeneration}`
    inFlight.set(flightKey, controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    let accepted = false
    let refusal: unknown
    try {
      fence()
      const current = liveFor(request)
      if (
        current.archived ||
        current.runId !== attempt.live.runId ||
        current.runVersion !== attempt.live.runVersion ||
        current.deliveryBinding !== attempt.live.deliveryBinding ||
        current.state !== 'awaiting_input'
      )
        error('invalid_state', 'follow-up input boundary changed before handoff')
      const interrupted = new Promise<{ ok: boolean }>((resolve) => {
        onAbort = () => resolve({ ok: false })
        controller.signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => {
          controller.abort()
        }, input.deliveryTimeoutMs ?? 5_000)
      })
      const verdict = await Promise.race([
        input.deliver!({
          runtimeSessionId: request.runtimeSessionId,
          generation: request.expectedGeneration,
          runId: attempt.live.runId!,
          messageId: item.id,
          text: item.text,
          signal: controller.signal,
          deliveryBinding: attempt.live.deliveryBinding,
        }),
        interrupted,
      ])
      fence()
      const after = liveFor(request)
      if (
        after.archived ||
        after.runId !== attempt.live.runId ||
        after.deliveryBinding !== attempt.live.deliveryBinding
      )
        error('stale_generation', 'follow-up run identity changed during handoff')
      accepted = verdict.ok === true && !controller.signal.aborted
    } catch (cause) {
      refusal = cause
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      inFlight.delete(flightKey)
    }
    const snapshot = await storage.locked(async () => {
      try {
        fence()
        const finalLive = liveFor(request)
        if (
          finalLive.archived ||
          finalLive.runId !== attempt.live.runId ||
          finalLive.deliveryBinding !== attempt.live.deliveryBinding
        )
          error('stale_generation', 'follow-up authority changed before finalizing delivery')
      } catch (cause) {
        accepted = false
        refusal ??= cause
      }
      const state = load(request.runtimeSessionId)
      if (!state || state.generation !== request.expectedGeneration || state.stopped)
        return undefined
      flush(state)
      const claimed = state.items.findIndex(
        (entry) => entry.id === item.id && entry.state === 'dispatching'
      )
      if (claimed < 0) return undefined
      state.lastDelivery = { messageId: item.id, status: accepted ? 'accepted' : 'ambiguous' }
      if (accepted) state.items.splice(claimed, 1)
      else state.items[claimed] = { ...state.items[claimed]!, state: 'ambiguous' }
      publish(state, accepted ? 'delivery_accepted' : 'delivery_ambiguous')
      return view(state, input.resolve(request.runtimeSessionId))
    })
    if (refusal) throw refusal
    if (!snapshot)
      error('stale_generation', 'follow-up queue was cancelled or replaced during handoff')
    return snapshot
  }
  async function cancelGeneration(sessionId: string, generation: number): Promise<void> {
    inFlight.get(`${sessionId}:${generation}`)?.abort()
    await storage.locked(async () => {
      const state = load(sessionId)
      if (!state || state.generation !== generation || state.stopped) return
      flush(state)
      const claimed = state.items.find((item) => item.state !== 'queued')
      if (claimed) state.lastDelivery = { messageId: claimed.id, status: 'ambiguous' }
      state.items = []
      state.stopped = true
      publish(state, 'cancelled')
    })
  }
  return { execute, cancelGeneration, storageFile: storage.storageFile }
}
