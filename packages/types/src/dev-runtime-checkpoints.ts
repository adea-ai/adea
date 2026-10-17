import { devErrorCodes, type DevErrorCode } from './dev-runtime-errors'
import {
  exactKeys,
  fail,
  integerValue,
  literal,
  record,
  stringValue,
  timestamp,
} from './dev-runtime-validation-internal'

export type ConversationCheckpoint = Readonly<{
  schemaVersion: 1
  checkpointId: string
  name: string
  createdAt: string
  harnessInstallationId: string
  restore:
    | Readonly<{ supported: true }>
    | Readonly<{ supported: false; reason: 'harness_restore_unavailable' }>
}>
export type CheckpointRestoreRequest = Readonly<{
  schemaVersion: 1
  restoreId: string
  checkpointId: string
  checkpointEventId: string
  requestedGeneration: number
  requestedAt: string
}>
type RestoreOutcome = Omit<CheckpointRestoreRequest, 'requestedAt'> &
  Readonly<{ completedAt: string }>
export type CheckpointRestoreOutcome = RestoreOutcome &
  (
    | Readonly<{
        status: 'resolved'
        restoredGeneration: number
        providerRestoreId: string
        restoredAt: string
      }>
    | Readonly<{ status: 'failed'; code: DevErrorCode }>
  )

function nonblank(value: unknown, path: string, max = 256): string {
  const text = stringValue(value, path, 1, max)
  if (!text.trim()) fail(path, 'expected nonblank string')
  return text
}
export function decodeConversationCheckpoint(value: unknown): ConversationCheckpoint {
  const item = record(value, 'checkpoint')
  exactKeys(
    item,
    ['schemaVersion', 'checkpointId', 'name', 'createdAt', 'harnessInstallationId', 'restore'],
    [],
    'checkpoint'
  )
  literal(item.schemaVersion, [1], 'checkpoint.schemaVersion')
  nonblank(item.checkpointId, 'checkpoint.checkpointId')
  nonblank(item.name, 'checkpoint.name', 512)
  nonblank(item.harnessInstallationId, 'checkpoint.harnessInstallationId')
  timestamp(item.createdAt, 'checkpoint.createdAt')
  const restore = record(item.restore, 'checkpoint.restore')
  literal(restore.supported, [true, false], 'checkpoint.restore.supported')
  exactKeys(
    restore,
    restore.supported ? ['supported'] : ['supported', 'reason'],
    [],
    'checkpoint.restore'
  )
  if (!restore.supported)
    literal(restore.reason, ['harness_restore_unavailable'], 'checkpoint.restore.reason')
  return value as ConversationCheckpoint
}
function restoreIdentity(item: Record<string, unknown>): void {
  literal(item.schemaVersion, [1], 'restore.schemaVersion')
  for (const key of ['restoreId', 'checkpointId', 'checkpointEventId'])
    nonblank(item[key], `restore.${key}`)
  integerValue(
    item.requestedGeneration,
    'restore.requestedGeneration',
    0,
    Number.MAX_SAFE_INTEGER - 1
  )
}
export function decodeCheckpointRestoreRequest(value: unknown): CheckpointRestoreRequest {
  const item = record(value, 'restore')
  exactKeys(
    item,
    [
      'schemaVersion',
      'restoreId',
      'checkpointId',
      'checkpointEventId',
      'requestedGeneration',
      'requestedAt',
    ],
    [],
    'restore'
  )
  restoreIdentity(item)
  timestamp(item.requestedAt, 'restore.requestedAt')
  return value as CheckpointRestoreRequest
}
export function decodeCheckpointRestoreOutcome(value: unknown): CheckpointRestoreOutcome {
  const item = record(value, 'restore')
  literal(item.status, ['resolved', 'failed'], 'restore.status')
  exactKeys(
    item,
    [
      'schemaVersion',
      'restoreId',
      'checkpointId',
      'checkpointEventId',
      'requestedGeneration',
      'completedAt',
      'status',
      ...(item.status === 'resolved'
        ? ['restoredGeneration', 'providerRestoreId', 'restoredAt']
        : ['code']),
    ],
    [],
    'restore'
  )
  restoreIdentity(item)
  timestamp(item.completedAt, 'restore.completedAt')
  if (item.status === 'resolved') {
    nonblank(item.providerRestoreId, 'restore.providerRestoreId')
    timestamp(item.restoredAt, 'restore.restoredAt')
    // requestedGeneration is already bounded to 0..MAX_SAFE_INTEGER-1.
    // Equal integer bounds preserve both safe-integer validation and the
    // exact-next-generation requirement through the shared validator.
    const nextGeneration = (item.requestedGeneration as number) + 1
    integerValue(
      item.restoredGeneration,
      'restore.restoredGeneration',
      nextGeneration,
      nextGeneration
    )
  } else literal(item.code, devErrorCodes, 'restore.code')
  return value as CheckpointRestoreOutcome
}

/** Legacy markers remain opaque. A claimed restore capability requires the new schema. */
export function decodeCheckpointEventPayload(kind: string, value: unknown): object | undefined {
  if (kind === 'checkpoint.observed') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const item = record(value, 'checkpoint')
    if (!('schemaVersion' in item)) {
      if ('restore' in item) fail('checkpoint.restore', 'requires versioned evidence')
      return undefined
    }
    return decodeConversationCheckpoint(value)
  }
  if (kind === 'checkpoint.restore_requested') return decodeCheckpointRestoreRequest(value)
  if (kind === 'checkpoint.restore_resolved' || kind === 'checkpoint.restore_failed') {
    const outcome = decodeCheckpointRestoreOutcome(value)
    if (outcome.status !== (kind === 'checkpoint.restore_resolved' ? 'resolved' : 'failed'))
      fail('restore.status', 'does not match event kind')
    return outcome
  }
  return undefined
}
