import 'server-only'

import { GroupCreationError } from '@adea-ai/db'
import type {
  ConversationParticipantRef,
  GroupAgentEnlistmentGrant,
  GroupAudienceGrant,
} from '@adea-ai/types'

import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'

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

export function conversationErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Lead turn model selection conflict')
    return workspaceJsonResponse({ code: 'conversation_conflict', message }, resolution, request, {
      status: 409,
    })
  if (error instanceof GroupCreationError)
    return workspaceJsonResponse(
      { code: 'group_grant_rejected', message: error.message, rejections: error.rejections },
      resolution,
      request,
      { status: 400 }
    )
  if (message.endsWith('version conflict') || message.endsWith('idempotency conflict'))
    return workspaceJsonResponse({ code: 'conversation_conflict', message }, resolution, request, {
      status: 409,
    })
  if (
    message === 'Primary Project Channel required' ||
    message.endsWith('thread conflict') ||
    message.endsWith('reply conflict')
  )
    return workspaceJsonResponse({ code: 'conversation_conflict', message }, resolution, request, {
      status: 409,
    })
  // A viewer of a members-only project reads but cannot write there.
  if (message === 'Project read-only')
    return workspaceJsonResponse({ code: 'project_read_only', message }, resolution, request, {
      status: 403,
    })
  if (message.endsWith('unavailable')) return workspaceUnavailableResponse(request)
  // Log the underlying failure: the client only receives a generic message, so
  // the server terminal is the only place the real cause is visible.
  console.error('[conversation] unmapped error response', message || error)
  return workspaceJsonResponse(
    { code: 'invalid_request', message: 'Invalid request' },
    resolution,
    request,
    { status: 400 }
  )
}
