import 'server-only'

import type { ConversationParticipantRef } from '@adea-ai/types'

export { conversationErrorResponse } from './conversation-response'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isConversationUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function readConversationVersion(request: Request): number | null {
  const version = Number(request.headers.get('if-match')?.trim())
  return Number.isInteger(version) && version > 0 ? version : null
}

export function parseConversationParticipant(value: unknown): ConversationParticipantRef | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'user' && isConversationUuid(candidate.userId))
    return { kind: 'user', userId: candidate.userId }
  if (candidate.kind === 'agent' && isConversationUuid(candidate.agentId))
    return { agentId: candidate.agentId, kind: 'agent' }
  return null
}
