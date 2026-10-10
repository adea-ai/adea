/**
 * Pure conversation error projection (M14.03.1, adea-ai/adea#1215).
 *
 * This builder is deliberately free of the `server-only` marker so the unit
 * lane can exercise the exact typed conflict mapping without a server runtime;
 * `conversation-request.ts` re-exports it for the server routes and keeps the
 * marker on the request-handling surface.
 */
import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'

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
