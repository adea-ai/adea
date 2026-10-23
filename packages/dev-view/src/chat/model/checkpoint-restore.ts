// Restoring a conversation to a checkpoint the host named (`dev.session.restoreCheckpoint`).
//
// A restore is the host's decision and the host's result. This module asks once and reports
// what the host answered, in its words:
//
// - It is offered only for a checkpoint the host marked `restore.supported`, and the host
//   still rechecks that, the session, the generation and the retained checkpoint event.
// - Success is the typed `resolved` outcome naming the next generation. A delivered request,
//   a missing answer or a failed outcome is never reported as a restore.
// - The same restore retried after an answer was lost reuses its idempotency key, so the
//   host replays its decision instead of running a second restore. A definite answer ends
//   that key.
// - It does not move the conversation: the host starts a new generation and the surface
//   learns it from the session the host publishes, not from this call.
import type { DevError, Scope } from '@adea-ai/types/dev-runtime'
import {
  decodeCheckpointRestoreOutcome,
  type CheckpointRestoreOutcome,
} from '@adea-ai/types/dev-runtime'

import type { DevRuntimeService } from '../../platform'
import { buildConversationCommand, ChatRuntimeError, executeChatCommand } from './commands'

export type CheckpointRestoreIdentity = Readonly<{ runtimeSessionId: string; generation: number }>

export type CheckpointRestorePort = Readonly<{
  restore(
    identity: CheckpointRestoreIdentity,
    input: Readonly<{ checkpointEventId: string; idempotencyKey: string }>
  ): Promise<CheckpointRestoreOutcome>
}>

export type CheckpointRestoreOptions = Readonly<{
  now?: () => Date
  randomId?: () => string
}>

/** The host envelope key: printable ASCII, 1-128 characters. */
function restoreKey(randomId: () => string): string {
  return `restore-${randomId()}`.replace(/[^\x21-\x7e]/g, '-').slice(0, 128)
}

export function createCheckpointRestorePort(
  service: DevRuntimeService,
  scope: Scope,
  options: CheckpointRestoreOptions = {}
): CheckpointRestorePort {
  const randomId = options.randomId ?? (() => crypto.randomUUID())
  return {
    async restore(identity, input) {
      const command = buildConversationCommand({
        operation: 'dev.session.restoreCheckpoint',
        scope,
        body: {
          runtimeSessionId: identity.runtimeSessionId,
          expectedGeneration: identity.generation,
          checkpointEventId: input.checkpointEventId,
        },
        resource: {
          kind: 'runtime_session',
          id: identity.runtimeSessionId,
          generation: identity.generation,
        },
        idempotencyKey: input.idempotencyKey,
        ...(options.now ? { now: options.now } : {}),
        randomId,
      })
      const value = await executeChatCommand<unknown>(service, command)
      const outcome = decodeCheckpointRestoreOutcome(value)
      // An answer about another checkpoint event or generation is not this restore.
      if (
        outcome.checkpointEventId !== input.checkpointEventId ||
        outcome.requestedGeneration !== identity.generation
      )
        throw new ChatRuntimeError({
          code: 'identity_mismatch',
          retryable: false,
          message: 'The restore answered for another checkpoint or generation.',
        })
      return outcome
    },
  }
}

export type CheckpointRestoreResult = Readonly<
  | { status: 'resolved'; restoredGeneration: number; restoredAt: string }
  | { status: 'failed'; code?: DevError['code']; message: string }
  // The conversation closed before the answer came back. Nothing here may act on it.
  | { status: 'closed' }
>

export type CheckpointRestorer = Readonly<{
  /** At most one restore at a time; a second call while one runs is refused with a reason. */
  restore(checkpointEventId: string): Promise<CheckpointRestoreResult>
  dispose(): void
}>

const FAILURE_TEXT: Partial<Record<DevError['code'], string>> = {
  stale_generation:
    'This conversation moved on while you were deciding. Reload it and look at the checkpoint again.',
  resync_required: 'The host no longer holds this checkpoint, so it cannot be restored.',
  identity_mismatch: 'This checkpoint belongs to another session, so it cannot be restored.',
  unsupported_capability: 'This host cannot restore checkpoints.',
  capability_unavailable: 'This host cannot restore checkpoints.',
  capability_denied: 'You are not allowed to restore this conversation.',
  limit_exceeded: 'The host has reached its limit of recorded restores for this workspace.',
}

/** What can be said when the host refused or failed, in its own terms and never as success. */
export function checkpointRestoreFailureText(
  code: DevError['code'] | undefined,
  hostMessage: string
) {
  return (code ? FAILURE_TEXT[code] : undefined) ?? (hostMessage || 'The restore did not complete.')
}

/** The same words the confirmation shows before the restore is asked for. */
export const CHECKPOINT_RESTORE_CONSEQUENCE =
  'The host returns this conversation to the checkpoint and continues it as a new generation. Earlier messages stay in the history; anything you type before it finishes may be set aside.'

const DEFINITE_FAILURES: readonly DevError['code'][] = [
  'stale_generation',
  'resync_required',
  'identity_mismatch',
  'unsupported_capability',
  'capability_unavailable',
  'capability_denied',
  'unauthorized',
  'not_found',
  'invalid_state',
  'limit_exceeded',
]

export function createCheckpointRestorer(input: {
  port: CheckpointRestorePort
  identity: CheckpointRestoreIdentity
  randomId?: () => string
}): CheckpointRestorer {
  const randomId = input.randomId ?? (() => crypto.randomUUID())
  let inflight: string | undefined
  let disposed = false
  // Kept while the outcome of a restore is unknown, so a retry replays it.
  let pendingKey: { checkpointEventId: string; key: string } | undefined
  return {
    async restore(checkpointEventId) {
      if (disposed) return { status: 'failed', message: 'This conversation is no longer open.' }
      if (inflight !== undefined)
        return { status: 'failed', message: 'A restore is already running.' }
      const key =
        pendingKey?.checkpointEventId === checkpointEventId ? pendingKey.key : restoreKey(randomId)
      pendingKey = { checkpointEventId, key }
      inflight = checkpointEventId
      try {
        const outcome = await input.port.restore(input.identity, {
          checkpointEventId,
          idempotencyKey: key,
        })
        pendingKey = undefined
        if (disposed) return { status: 'closed' }
        if (outcome.status === 'resolved')
          return {
            status: 'resolved',
            restoredGeneration: outcome.restoredGeneration,
            restoredAt: outcome.restoredAt,
          }
        return {
          status: 'failed',
          code: outcome.code,
          message: checkpointRestoreFailureText(outcome.code, ''),
        }
      } catch (error) {
        const code =
          error instanceof ChatRuntimeError
            ? error.code
            : typeof error === 'object' && error !== null && 'code' in error
              ? (error as { code: DevError['code'] }).code
              : undefined
        if (code && DEFINITE_FAILURES.includes(code)) pendingKey = undefined
        if (disposed) return { status: 'closed' }
        return {
          status: 'failed',
          ...(code ? { code } : {}),
          message: checkpointRestoreFailureText(code, error instanceof Error ? error.message : ''),
        }
      } finally {
        inflight = undefined
      }
    },
    dispose() {
      disposed = true
    },
  }
}

export type CheckpointRestored = Readonly<{
  runtimeSessionId: string
  /** The generation the restore was asked from. */
  previousGeneration: number
  restoredGeneration: number
}>

/**
 * Turns one restore into the one thing the surface may do with its answer: tell the owner, and
 * only while this conversation is still the one that asked.
 *
 * - An answer that settles after the conversation closed, switched or moved to another
 *   generation is dropped: no success, no error, no callback.
 * - A resolved answer that does not name a later generation is an error, not a restore.
 * - The callback names the session and generation it answers for, so an owner can check it too.
 */
export function bindCheckpointRestore(input: {
  restorer: CheckpointRestorer
  identity: CheckpointRestoreIdentity
  /** The conversation the surface shows now. */
  current: () => CheckpointRestoreIdentity
  onRestored?: (restored: CheckpointRestored) => void
}) {
  const { identity } = input
  return async (checkpointEventId: string): Promise<void> => {
    const result = await input.restorer.restore(checkpointEventId)
    if (result.status === 'closed') return
    const now = input.current()
    if (
      now.runtimeSessionId !== identity.runtimeSessionId ||
      now.generation !== identity.generation
    )
      return
    if (result.status === 'failed') throw new Error(result.message)
    if (!(result.restoredGeneration > identity.generation))
      throw new Error('The host answered with a generation that does not follow this one.')
    input.onRestored?.({
      runtimeSessionId: identity.runtimeSessionId,
      previousGeneration: identity.generation,
      restoredGeneration: result.restoredGeneration,
    })
  }
}
