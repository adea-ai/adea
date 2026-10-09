import type { ApiAgentPresentationInput, ApiAgentProjectInput } from '@adea-ai/api-client'
import { isRecord } from './control-plane-client'

// Fail closed: unknown keys, missing or malformed revisions, and empty edits never reach the
// database. The database re-checks the revision under the Agent row lock.
const PRESENTATION_FIELDS = [
  'avatarRef',
  'characterRef',
  'name',
  'presentationMetadata',
  'roleSummary',
] as const

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isMetadata(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

export function parseAgentPresentationChange(input: unknown): ApiAgentPresentationInput | null {
  if (!isRecord(input) || !isRevision(input.expectedRevision)) return null
  const fields = Object.keys(input).filter((key) => key !== 'expectedRevision')
  if (
    fields.length === 0 ||
    fields.some((key) => !(PRESENTATION_FIELDS as readonly string[]).includes(key))
  )
    return null
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim()))
    return null
  if (
    (input.avatarRef !== undefined && !isNullableText(input.avatarRef)) ||
    (input.characterRef !== undefined && !isNullableText(input.characterRef)) ||
    (input.roleSummary !== undefined && !isNullableText(input.roleSummary))
  )
    return null
  if (input.presentationMetadata !== undefined && !isMetadata(input.presentationMetadata))
    return null
  const change: Record<string, unknown> = { expectedRevision: input.expectedRevision }
  for (const field of fields) change[field] = input[field]
  return change as ApiAgentPresentationInput
}

export function parseAgentProjectChange(input: unknown): ApiAgentProjectInput | null {
  if (!isRecord(input) || !isRevision(input.expectedRevision)) return null
  if (Object.keys(input).some((key) => key !== 'expectedRevision' && key !== 'projectId'))
    return null
  if (input.projectId !== null && (typeof input.projectId !== 'string' || !input.projectId.trim()))
    return null
  return { expectedRevision: input.expectedRevision, projectId: input.projectId }
}
