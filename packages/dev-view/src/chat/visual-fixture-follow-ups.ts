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

/** A stand-in for the host's checkpoint restore: it answers with a typed outcome and nothing else. */
export function createFixtureCheckpointRestore(
  mode: 'ok' | 'fail'
): import('./model').CheckpointRestorePort {
  return {
    async restore(identity, input) {
      const base = {
        schemaVersion: 1 as const,
        restoreId: 'fixture-restore-1',
        checkpointId: 'checkpoint-1',
        checkpointEventId: input.checkpointEventId,
        requestedGeneration: identity.generation,
        completedAt: '2026-10-23T10:00:00.000Z',
      }
      return mode === 'ok'
        ? {
            ...base,
            status: 'resolved' as const,
            restoredGeneration: identity.generation + 1,
            providerRestoreId: 'fixture-provider-restore',
            restoredAt: '2026-10-23T10:00:00.000Z',
          }
        : { ...base, status: 'failed' as const, code: 'resync_required' as const }
    },
  }
}

const fixtureAttachment = (
  identity: import('./model').AttachmentIdentity,
  id: string,
  name: string,
  byteLength: number,
  state: 'available' | 'removed'
): import('@adea-ai/types/dev-runtime').ChatAttachment => ({
  attachmentId: id,
  mediaType: 'text/plain',
  byteLength,
  state,
  runtimeSessionId: identity.runtimeSessionId,
  generation: identity.generation,
  name,
  digestSha256: '0'.repeat(64),
  createdAt: '2026-10-23T10:00:00.000Z',
  ...(state === 'removed' ? { removedAt: '2026-10-23T10:01:00.000Z' } : {}),
})
export type FixtureAttachmentMode =
  /** The host stores and removes every file. */
  | 'ok'
  /** The first upload's answer is lost, then the retry under the same key is stored once. */
  | 'lost'
  /** The host refuses to remove a stored file. */
  | 'remove-fail'

/** A stand-in for the host's attachment store: it answers with the real DTO shapes and nothing else. */
export function createFixtureAttachments(
  mode: FixtureAttachmentMode
): import('./model').AttachmentPort {
  let n = 0
  const stored = new Map<string, string>()
  const byKey = new Map<string, import('@adea-ai/types/dev-runtime').ChatAttachment>()
  let lost = mode === 'lost'
  return {
    async upload(identity, input) {
      const existing = byKey.get(input.idempotencyKey)
      if (existing) return existing
      n += 1
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
      const byteLength = atob(input.upload.contentBase64).length
      const made = fixtureAttachment(identity, id, input.upload.name, byteLength, 'available')
      stored.set(id, input.upload.name)
      byKey.set(input.idempotencyKey, made)
      if (lost) {
        lost = false
        throw refuse('timeout', 'The host did not answer.')
      }
      return made
    },
    async remove(identity, attachmentId) {
      if (mode === 'remove-fail')
        throw refuse('capability_unavailable', 'The host cannot remove files right now.')
      const name = stored.get(attachmentId)
      if (name === undefined) throw refuse('not_found', 'No such attachment.')
      stored.delete(attachmentId)
      return fixtureAttachment(identity, attachmentId, name, 1, 'removed')
    },
  }
}
