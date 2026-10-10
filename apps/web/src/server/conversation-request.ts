import 'server-only'

import type {
  ConversationParticipantRef,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
} from '@adea-ai/types'

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

function parseGrantIdentity(value: Record<string, unknown>): {
  grantId: string
  revision: number
} | null {
  if (
    typeof value.grantId !== 'string' ||
    !value.grantId.trim() ||
    value.grantId.length > 128 ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    return null
  return { grantId: value.grantId, revision: value.revision }
}

function parseGrantWindow(value: Record<string, unknown>): {
  expiresAt: string | null
  issuedAt: string
  revokedAt: string | null
} | null {
  if (typeof value.issuedAt !== 'string' || !value.issuedAt.trim()) return null
  for (const field of ['expiresAt', 'revokedAt'] as const) {
    const entry = value[field]
    if (entry !== undefined && entry !== null && typeof entry !== 'string') return null
  }
  return {
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
    issuedAt: value.issuedAt,
    revokedAt: typeof value.revokedAt === 'string' ? value.revokedAt : null,
  }
}

/**
 * Strict wire parser for a human audience grant. The grant must already name
 * the group being created — cross-group grants are rejected here and again
 * by the policy, never relabelled.
 */
export function parseGroupAudienceGrant(value: unknown): GroupAudienceGrant | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const identity = parseGrantIdentity(candidate)
  const window = parseGrantWindow(candidate)
  const participant = parseConversationParticipant(candidate.participant)
  if (
    !identity ||
    !window ||
    !participant ||
    participant.kind !== 'user' ||
    typeof candidate.groupId !== 'string' ||
    !candidate.groupId.trim()
  )
    return null
  return { ...identity, ...window, groupId: candidate.groupId, participant }
}

/** Strict wire parser for an Agent enlistment grant, bound to its group like above. */
export function parseGroupEnlistmentGrant(value: unknown): GroupAgentEnlistmentGrant | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const identity = parseGrantIdentity(candidate)
  const window = parseGrantWindow(candidate)
  const agent = candidate.agent as Record<string, unknown> | undefined
  if (
    !identity ||
    !window ||
    !agent ||
    typeof agent !== 'object' ||
    !isConversationUuid(agent.agentId) ||
    !isConversationUuid(agent.workspaceId) ||
    typeof candidate.groupId !== 'string' ||
    !candidate.groupId.trim()
  )
    return null
  return {
    ...identity,
    ...window,
    agent: { agentId: agent.agentId as string, workspaceId: agent.workspaceId as string },
    groupId: candidate.groupId,
  }
}
