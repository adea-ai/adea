// A stand-in for the host's `dev.session.followUps` queue, for the visual fixture only. It keeps
// the real contract's shape (versioned snapshots, one delivery at a time, a stale version is
// refused) so the surface is driven through the same port it uses against a host.
import type { FollowUpQueueSnapshot } from '@adea-ai/types/dev-runtime-follow-ups'

import { ChatRuntimeError, type FollowUpIdentity, type FollowUpQueuePort } from './model'

export type FixtureFollowUpMode =
  /** The agent is working: messages queue, nothing can be delivered yet. */
  | 'busy'
  /** The agent is waiting for input: the head can be delivered when the person chooses. */
  | 'ready'
  /** A message whose delivery could not be confirmed. */
  | 'ambiguous'
  /** The host does not offer the operation. */
  | 'unavailable'

const refuse = (code: string, message: string) =>
  new ChatRuntimeError({ code, retryable: false, message } as never)

export function createFixtureFollowUpHost(mode: FixtureFollowUpMode): FollowUpQueuePort {
  let version = 1
  let items: Array<{ id: string; text: string; state: 'queued' | 'dispatching' | 'ambiguous' }> =
    mode === 'ambiguous'
      ? [{ id: 'seed-1', text: 'Also run the migration dry run.', state: 'ambiguous' }]
      : []
  let lastDelivery: FollowUpQueueSnapshot['lastDelivery']
  const snapshot = (identity: FollowUpIdentity): FollowUpQueueSnapshot => ({
    schemaVersion: 1,
    runtimeSessionId: identity.runtimeSessionId,
    generation: identity.generation,
    version,
    delivery: mode === 'ready' ? 'ready' : 'busy',
    items: items.map((item) => ({ ...item, bytes: new TextEncoder().encode(item.text).length })),
    ...(lastDelivery ? { lastDelivery } : {}),
  })
  const guard = (identity: FollowUpIdentity, expectedVersion?: number) => {
    if (mode === 'unavailable')
      throw refuse('capability_unavailable', 'Queued messages are not offered by this host.')
    if (expectedVersion !== undefined && expectedVersion !== version)
      throw refuse('stale_version', 'The queue changed. Review it and try again.')
    void identity
  }
  return {
    async read(identity) {
      guard(identity)
      return snapshot(identity)
    },
    async enqueue(identity, input) {
      guard(identity, input.expectedVersion)
      items = [...items, { id: input.messageId, text: input.text, state: 'queued' }]
      version += 1
      return snapshot(identity)
    },
    async remove(identity, input) {
      guard(identity, input.expectedVersion)
      const target = items.find((item) => item.id === input.messageId)
      if (!target || target.state === 'dispatching')
        throw refuse('invalid_state', 'That message can no longer be removed.')
      items = items.filter((item) => item !== target)
      version += 1
      return snapshot(identity)
    },
    async deliver(identity, input) {
      guard(identity, input.expectedVersion)
      const head = items[0]
      if (mode !== 'ready' || !head || head.state !== 'queued')
        throw refuse('invalid_state', 'Nothing can be delivered right now.')
      items = items.slice(1)
      lastDelivery = { messageId: head.id, status: 'accepted' }
      version += 1
      return snapshot(identity)
    },
  }
}
