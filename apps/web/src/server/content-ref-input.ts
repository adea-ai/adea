import type { ApiContentRefCreateInput, ApiContentRefUpdateInput } from '@adea-ai/api-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/
const CREATE_KEYS = new Set([
  'availability',
  'contentType',
  'digestSha256',
  'id',
  'keyVersion',
  'messageId',
  'schemaVersion',
  'sensitivity',
  'storagePolicy',
  'synchronizationPolicy',
  'taskId',
])
const UPDATE_KEYS = new Set([
  'availability',
  'digestSha256',
  'expectedRevision',
  'keyVersion',
  'revision',
])

export const isContentRefUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value)

const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0

export function parseContentRefCreateInput(value: unknown): ApiContentRefCreateInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !CREATE_KEYS.has(key)) ||
    !isContentRefUuid(input.id) ||
    !['message_body', 'task_objective', 'task_input', 'private_field'].includes(
      String(input.contentType)
    ) ||
    !DIGEST.test(String(input.digestSha256)) ||
    !positiveInteger(input.keyVersion) ||
    !positiveInteger(input.schemaVersion) ||
    !['sensitive', 'restricted'].includes(String(input.sensitivity)) ||
    input.storagePolicy !== 'local_authority' ||
    !['local_only', 'e2e_optional'].includes(String(input.synchronizationPolicy)) ||
    !['available', 'offline', 'missing'].includes(String(input.availability)) ||
    (input.taskId !== undefined && !isContentRefUuid(input.taskId)) ||
    (input.messageId !== undefined && !isContentRefUuid(input.messageId))
  )
    return null
  return input as ApiContentRefCreateInput
}

export function parseContentRefUpdateInput(value: unknown): ApiContentRefUpdateInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !UPDATE_KEYS.has(key)) ||
    Object.keys(input).length !== UPDATE_KEYS.size ||
    !['available', 'offline', 'missing', 'deleted'].includes(String(input.availability)) ||
    !DIGEST.test(String(input.digestSha256)) ||
    !positiveInteger(input.expectedRevision) ||
    !positiveInteger(input.keyVersion) ||
    !positiveInteger(input.revision) ||
    Number(input.revision) < Number(input.expectedRevision) ||
    Number(input.revision) > Number(input.expectedRevision) + 1
  )
    return null
  return input as ApiContentRefUpdateInput
}
