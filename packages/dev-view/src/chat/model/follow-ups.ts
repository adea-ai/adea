// Consumer of the authorized `dev.session.followUps` host queue (#1393, #1383).
//
// The host owns the queue: this module only reads its snapshot, asks for one
// change at a time and shows what the host answered. What it may not do:
//
// - It never sends a queued message on its own. Delivery is the host's explicit,
//   one-at-a-time `deliver` action, so there is no timer, no drain on idle and no
//   "send when ready" promise; the person presses Send next.
// - It never reads `accepted` as "the agent consumed it". The host says only that
//   the transport accepted the bytes, and the words here say the same.
// - It never retries an ambiguous delivery. The host refuses a second claim until
//   the ambiguous item is removed, and so does this controller.
// - It never guesses a version. A mutation carries the version of the snapshot it
//   was drawn from; a `stale_version` reply re-reads the queue and asks the person
//   to look again instead of replaying the change against a newer queue.
import type { DevError, RuntimeEvent, Scope } from '@adea-ai/types/dev-runtime'
import {
  decodeFollowUpQueueSnapshot,
  FOLLOW_UP_QUEUE_MAX_ITEMS,
  FOLLOW_UP_TEXT_MAX_BYTES,
  type FollowUpQueueRequest,
  type FollowUpQueueSnapshot,
} from '@adea-ai/types/dev-runtime-follow-ups'

import type { DevRuntimeService } from '../../platform'
import { buildConversationCommand, ChatRuntimeError, executeChatCommand } from './commands'

export type FollowUpIdentity = Readonly<{ runtimeSessionId: string; generation: number }>

export type FollowUpQueuePort = Readonly<{
  read(identity: FollowUpIdentity): Promise<FollowUpQueueSnapshot>
  enqueue(
    identity: FollowUpIdentity,
    input: Readonly<{
      expectedVersion: number
      messageId: string
      text: string
      idempotencyKey?: string
    }>
  ): Promise<FollowUpQueueSnapshot>
  remove(
    identity: FollowUpIdentity,
    input: Readonly<{ expectedVersion: number; messageId: string; idempotencyKey?: string }>
  ): Promise<FollowUpQueueSnapshot>
  deliver(
    identity: FollowUpIdentity,
    input: Readonly<{ expectedVersion: number; idempotencyKey?: string }>
  ): Promise<FollowUpQueueSnapshot>
}>

export type FollowUpPortOptions = Readonly<{
  now?: () => Date
  randomId?: () => string
}>

type Mutation = Exclude<FollowUpQueueRequest['action'], 'read' | 'reorder'>

/** The host envelope key: printable ASCII, 1-128 characters. */
function mutationKey(randomId: () => string): string {
  return `followup-${randomId()}`.replace(/[^\x21-\x7e]/g, '-').slice(0, 128)
}

export function createFollowUpQueuePort(
  service: DevRuntimeService,
  scope: Scope,
  options: FollowUpPortOptions = {}
): FollowUpQueuePort {
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  const send = async (
    identity: FollowUpIdentity,
    body: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<FollowUpQueueSnapshot> => {
    const command = buildConversationCommand({
      operation: 'dev.session.followUps',
      scope,
      body: {
        runtimeSessionId: identity.runtimeSessionId,
        expectedGeneration: identity.generation,
        ...body,
      },
      resource: {
        kind: 'runtime_session',
        id: identity.runtimeSessionId,
        generation: identity.generation,
      },
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(options.now ? { now: options.now } : {}),
      randomId,
    })
    const value = await executeChatCommand<unknown>(service, command)
    const snapshot = decodeFollowUpQueueSnapshot(value)
    // A reply for another session or generation is not this queue.
    if (
      snapshot.runtimeSessionId !== identity.runtimeSessionId ||
      snapshot.generation !== identity.generation
    )
      throw new ChatRuntimeError({
        code: 'identity_mismatch',
        retryable: false,
        message: 'The follow-up queue answered for another session or generation.',
      })
    return snapshot
  }
  const mutate = (
    identity: FollowUpIdentity,
    action: Mutation,
    body: Record<string, unknown>,
    idempotencyKey: string | undefined
  ) => send(identity, { action, ...body }, idempotencyKey ?? mutationKey(randomId))
  return {
    read: (identity) => send(identity, { action: 'read' }),
    enqueue: (identity, input) =>
      mutate(
        identity,
        'enqueue',
        { expectedVersion: input.expectedVersion, messageId: input.messageId, text: input.text },
        input.idempotencyKey
      ),
    remove: (identity, input) =>
      mutate(
        identity,
        'remove',
        { expectedVersion: input.expectedVersion, messageId: input.messageId },
        input.idempotencyKey
      ),
    deliver: (identity, input) =>
      mutate(identity, 'deliver', { expectedVersion: input.expectedVersion }, input.idempotencyKey),
  }
}

export type FollowUpAction = 'read' | 'enqueue' | 'remove' | 'deliver'

export type FollowUpNotice = Readonly<{
  tone: 'error' | 'info'
  message: string
  code?: DevError['code']
}>

export type FollowUpQueueView = Readonly<{
  /**
   * `unavailable` until a read succeeds: a host without the operation, a refused
   * capability or a stale generation offers no queue at all rather than a dead control.
   */
  status: 'unavailable' | 'loading' | 'ready'
  snapshot?: FollowUpQueueSnapshot
  /** The one change in flight; a second is refused until it settles. */
  pending?: FollowUpAction
  notice?: FollowUpNotice
}>

export type FollowUpQueueController = Readonly<{
  view(): FollowUpQueueView
  subscribe(listener: (view: FollowUpQueueView) => void): () => void
  refresh(): Promise<void>
  enqueue(text: string): Promise<boolean>
  remove(messageId: string): Promise<boolean>
  deliver(): Promise<boolean>
  /** A `queue.updated` event named this version; re-read when it is newer than ours. */
  observeVersion(version: number): void
  dispose(): void
}>

export const FOLLOW_UP_UNAVAILABLE_TEXT =
  'Queued messages are not available for this session on this host.'

function errorCode(error: unknown): DevError['code'] | undefined {
  if (error instanceof ChatRuntimeError) return error.code
  if (typeof error === 'object' && error !== null && 'code' in error)
    return (error as { code: DevError['code'] }).code
  return undefined
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

const REFUSED_FOR_GOOD: readonly DevError['code'][] = [
  'stale_generation',
  'unsupported_capability',
  'capability_unavailable',
  'unauthorized',
  'capability_denied',
  'channel_unauthorized',
  'not_found',
  'identity_mismatch',
]

export function createFollowUpQueueController(input: {
  port: FollowUpQueuePort
  identity: FollowUpIdentity
  randomId?: () => string
}): FollowUpQueueController {
  const randomId = input.randomId ?? (() => crypto.randomUUID())
  const listeners = new Set<(view: FollowUpQueueView) => void>()
  let current: FollowUpQueueView = { status: 'loading' }
  let disposed = false
  // A retry of the same change reuses its key, so a transport loss between the host
  // applying it and us hearing back replays the answer instead of repeating the change.
  let lastAttempt: { fingerprint: string; key: string; messageId: string } | undefined

  const set = (next: FollowUpQueueView) => {
    if (disposed) return
    current = next
    for (const listener of listeners) listener(current)
  }
  const keep = (patch: Partial<FollowUpQueueView>) => set({ ...current, ...patch })
  const settle = (snapshot: FollowUpQueueSnapshot, notice?: FollowUpNotice) =>
    set({
      status: 'ready',
      snapshot,
      ...(notice ? { notice } : {}),
    })

  const read = async (): Promise<boolean> => {
    try {
      const snapshot = await input.port.read(input.identity)
      if (disposed) return false
      const previous = current.snapshot
      // Never move to an older queue because a slow read arrived late.
      if (previous && snapshot.version < previous.version) return true
      set({ status: 'ready', snapshot, ...(current.pending ? { pending: current.pending } : {}) })
      return true
    } catch (error) {
      if (disposed) return false
      const code = errorCode(error)
      if (code && REFUSED_FOR_GOOD.includes(code)) set({ status: 'unavailable' })
      else if (current.snapshot)
        keep({
          notice: {
            tone: 'error',
            message: errorText(error, 'The queue could not be refreshed.'),
            ...(code ? { code } : {}),
          },
        })
      else set({ status: 'unavailable' })
      return false
    }
  }

  const run = async (
    action: Exclude<FollowUpAction, 'read'>,
    fingerprint: string,
    work: (
      snapshot: FollowUpQueueSnapshot,
      attempt: Readonly<{ key: string; messageId: string }>
    ) => Promise<FollowUpQueueSnapshot>
  ): Promise<boolean> => {
    const snapshot = current.snapshot
    if (disposed || current.status !== 'ready' || !snapshot) return false
    if (current.pending) {
      keep({
        notice: { tone: 'info', message: 'Wait for the current change to finish.' },
      })
      return false
    }
    const attempt =
      lastAttempt?.fingerprint === fingerprint
        ? lastAttempt
        : {
            fingerprint,
            key: mutationKey(randomId),
            messageId: `message-${randomId()}`.slice(0, 128),
          }
    lastAttempt = attempt
    set({ status: 'ready', snapshot, pending: action })
    try {
      const next = await work(snapshot, attempt)
      lastAttempt = undefined
      if (disposed) return false
      settle(next.version >= snapshot.version ? next : snapshot)
      return true
    } catch (error) {
      if (disposed) return false
      const code = errorCode(error)
      if (code === 'stale_version') {
        lastAttempt = undefined
        set({ status: 'ready', snapshot })
        await read()
        keep({
          notice: {
            tone: 'info',
            message: 'The queue changed. Review it, then try again.',
            code: 'stale_version',
          },
        })
        return false
      }
      if (code && REFUSED_FOR_GOOD.includes(code)) {
        lastAttempt = undefined
        set({ status: 'unavailable' })
        return false
      }
      // Anything else: the host's own words, the queue exactly as it was.
      // A definite refusal is final for this attempt; an unknown outcome keeps its key.
      if (code && code !== 'timeout' && code !== 'backpressure' && code !== 'unavailable')
        lastAttempt = undefined
      set({
        status: 'ready',
        snapshot,
        notice: {
          tone: 'error',
          message: errorText(error, 'The queue could not be changed.'),
          ...(code ? { code } : {}),
        },
      })
      // The change may have been applied before the answer was lost; look.
      if (!code) void read()
      return false
    }
  }

  return {
    view: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async refresh() {
      await read()
    },
    async enqueue(text) {
      const body = text
      if (body.trim().length === 0) {
        keep({ notice: { tone: 'info', message: 'Write a message to queue.' } })
        return false
      }
      const bytes = new TextEncoder().encode(body).byteLength
      if (bytes > FOLLOW_UP_TEXT_MAX_BYTES) {
        keep({
          notice: {
            tone: 'error',
            message: `A queued message can be at most ${FOLLOW_UP_TEXT_MAX_BYTES.toLocaleString()} bytes.`,
          },
        })
        return false
      }
      if ((current.snapshot?.items.length ?? 0) >= FOLLOW_UP_QUEUE_MAX_ITEMS) {
        keep({
          notice: {
            tone: 'error',
            message: `The queue holds at most ${FOLLOW_UP_QUEUE_MAX_ITEMS} messages.`,
          },
        })
        return false
      }
      // The message identity is fixed per attempt: a retry of the same text reuses it.
      return run('enqueue', `enqueue:${body}`, (snapshot, attempt) =>
        input.port.enqueue(input.identity, {
          expectedVersion: snapshot.version,
          messageId: attempt.messageId,
          text: body,
          idempotencyKey: attempt.key,
        })
      )
    },
    remove(messageId) {
      const item = current.snapshot?.items.find((entry) => entry.id === messageId)
      if (!item || item.state === 'dispatching') return Promise.resolve(false)
      return run('remove', `remove:${messageId}`, (snapshot, attempt) =>
        input.port.remove(input.identity, {
          expectedVersion: snapshot.version,
          messageId,
          idempotencyKey: attempt.key,
        })
      )
    },
    deliver() {
      const snapshot = current.snapshot
      if (!snapshot || !canDeliverNext(snapshot)) return Promise.resolve(false)
      return run('deliver', `deliver:${snapshot.version}`, (latest, attempt) =>
        input.port.deliver(input.identity, {
          expectedVersion: latest.version,
          idempotencyKey: attempt.key,
        })
      )
    },
    observeVersion(version) {
      if (disposed || current.status === 'unavailable') return
      if (current.snapshot && version <= current.snapshot.version) return
      void read()
    },
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

/** Delivery is offered only when the host says it is ready and nothing is already claimed. */
export function canDeliverNext(snapshot: FollowUpQueueSnapshot): boolean {
  if (snapshot.delivery !== 'ready') return false
  const head = snapshot.items[0]
  return head !== undefined && head.state === 'queued'
}

/** What the queue may and may not be said to be doing, in the host's own terms. */
export function followUpDeliveryText(snapshot: FollowUpQueueSnapshot): string {
  if (snapshot.items.some((item) => item.state === 'ambiguous'))
    return 'Delivery of a message could not be confirmed. It is not retried automatically: remove it and queue it again if you still want it sent.'
  if (snapshot.items.some((item) => item.state === 'dispatching'))
    return 'A message is being handed to the agent.'
  if (snapshot.items.length === 0) return ''
  if (snapshot.delivery === 'ready')
    return 'The agent is waiting for input. Queued messages are sent one at a time, when you choose.'
  if (snapshot.delivery === 'busy')
    return 'Queued messages can be sent when the agent is waiting for input. Nothing is sent automatically.'
  return 'Sending queued messages is not available for this session right now.'
}

/** The last hand-off, worded so it never claims the agent read the message. */
export function followUpLastDeliveryText(snapshot: FollowUpQueueSnapshot): string | undefined {
  const last = snapshot.lastDelivery
  if (!last) return undefined
  return last.status === 'accepted'
    ? 'The last queued message was accepted by the agent’s input. That does not confirm the agent has read it.'
    : 'The last queued message may or may not have reached the agent.'
}

/**
 * The newest queue version a prompt-free `queue.updated` event in this window names for
 * this session generation, or undefined. The event carries no text: it only says the host's
 * queue changed, so the caller re-reads rather than trusting the event as a snapshot.
 */
export function latestQueueVersion(
  events: readonly RuntimeEvent[],
  identity: FollowUpIdentity
): number | undefined {
  let latest: number | undefined
  for (const event of events) {
    if (event.kind !== 'queue.updated') continue
    if (event.runtimeSessionId !== identity.runtimeSessionId) continue
    if (event.generation !== identity.generation) continue
    const version = (event.payload as { version?: unknown } | null)?.version
    if (typeof version === 'number' && (latest === undefined || version > latest)) latest = version
  }
  return latest
}
