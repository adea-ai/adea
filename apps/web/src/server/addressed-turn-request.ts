// No `server-only` marker: Bun-run unit tests import this pure module directly (same pattern as
// conversation-response). It parses and projects; it grants nothing.
import { isConversationUuid } from './conversation-request'
import { conversationErrorResponse } from './conversation-response'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'

/** The most a turn request can legitimately weigh; anything larger is refused unread. */
export const ADDRESSED_TURN_BODY_LIMIT = 1024

export type AddressedTurnRequestBody = Readonly<{
  agentId: string
  dispatchRevision: number
  parentTurnId: string | null
  triggerMessageId: string
}>

const BODY_KEYS = new Set(['agentId', 'dispatchRevision', 'parentTurnId', 'triggerMessageId'])

/**
 * Strict wire parser. The addresser is always the authenticated principal and the budget is always the
 * coordinator's own, so a body naming either (or anything else) is refused rather than ignored.
 */
export function parseAddressedTurnBody(value: unknown): AddressedTurnRequestBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) return null
  if (!isConversationUuid(body.triggerMessageId) || !isConversationUuid(body.agentId)) return null
  if (
    typeof body.dispatchRevision !== 'number' ||
    !Number.isSafeInteger(body.dispatchRevision) ||
    body.dispatchRevision < 1
  )
    return null
  if (
    body.parentTurnId !== undefined &&
    body.parentTurnId !== null &&
    !isConversationUuid(body.parentTurnId)
  )
    return null
  return {
    agentId: body.agentId,
    dispatchRevision: body.dispatchRevision,
    parentTurnId: typeof body.parentTurnId === 'string' ? body.parentTurnId : null,
    triggerMessageId: body.triggerMessageId,
  }
}

export type AddressedTurnQuery = Readonly<{ after?: string; limit?: number }>

/** `after` is a turn id from a previous page; `limit` is 1-200. Unknown parameters are refused. */
export function parseAddressedTurnQuery(url: URL): AddressedTurnQuery | null {
  for (const key of url.searchParams.keys()) if (key !== 'after' && key !== 'limit') return null
  const after = url.searchParams.get('after')
  const rawLimit = url.searchParams.get('limit')
  if (after !== null && !isConversationUuid(after)) return null
  let limit: number | undefined
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit)) return null
    limit = Number(rawLimit)
    if (limit < 1 || limit > 200) return null
  }
  return { ...(after === null ? null : { after }), ...(limit === undefined ? null : { limit }) }
}

// Reasons that mean "you may not know this exists": authorization, binding and enlistment failures all
// read like an unknown group so a revoked or never-admitted caller learns nothing about turns or Agents.
const UNAVAILABLE_REASONS = new Set([
  'agent_unknown',
  'turn_agent_expired',
  'turn_agent_not_enlisted',
  'turn_agent_not_yet_issued',
  'turn_agent_revoked',
  'turn_binding_mismatch',
  'turn_cancel_unauthorized',
  'turn_channel_unavailable',
  'turn_claim_unresolved',
  'turn_not_participant',
  'turn_parent_mismatch',
  'turn_parent_unknown',
  'turn_trigger_forged',
  'turn_trigger_unknown',
])
// Only reachable after the caller re-proved authority, so naming the state is not a disclosure.
const CONFLICT_REASONS = new Set([
  'turn_already_responded',
  'turn_budget_exhausted',
  'turn_cancelled',
  'turn_depth_exceeded',
  'turn_superseded',
])
const INVALID_REASONS = new Set([
  'turn_addresser_mismatch',
  'turn_cursor_invalid',
  'turn_not_addressed',
  'turn_revision_invalid',
  'turn_trigger_mismatch',
])

/** Project a coordinator failure. Identified by name and shape so this module needs no db import. */
export function addressedTurnErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  if (error instanceof Error && error.name === 'AddressedTurnError' && 'reason' in error) {
    const reason = String((error as { reason: unknown }).reason)
    if (UNAVAILABLE_REASONS.has(reason)) return workspaceUnavailableResponse(request)
    if (CONFLICT_REASONS.has(reason))
      return workspaceJsonResponse(
        { code: 'turn_conflict', message: 'Addressed turn conflict', reason },
        resolution,
        request,
        { status: 409 }
      )
    if (INVALID_REASONS.has(reason))
      return workspaceJsonResponse(
        { code: 'invalid_request', message: 'Invalid request' },
        resolution,
        request,
        { status: 400 }
      )
  }
  // Everything else (including "Channel unavailable") takes the shared conversation projection, which
  // answers unmapped failures with a generic 400 and logs the cause server-side.
  return conversationErrorResponse(error, resolution, request)
}
