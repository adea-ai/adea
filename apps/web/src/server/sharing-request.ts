import 'server-only'

import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/**
 * Where an invitation link opens. The token rides in the URL fragment, which
 * browsers never send to the server, proxies or `Referer`; the accept page
 * reads it client-side and POSTs it in a JSON body.
 */
export function invitationAcceptPath(token: string): string {
  return `/invite#token=${encodeURIComponent(token)}`
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

/** Maps sharing errors from `@adea-ai/db` onto the workspace API's responses. */
export function sharingErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Invitation invalid') return workspaceInvalidRequestResponse(request)
  if (message === 'Invitation already accepted')
    return workspaceJsonResponse({ code: 'invitation_conflict', message }, resolution, request, {
      status: 409,
    })
  if (message === 'Project read-only')
    return workspaceJsonResponse({ code: 'project_read_only', message }, resolution, request, {
      status: 403,
    })
  // A forbidden sharing change answers like an unknown project, as the
  // workspace routes already do for missing permissions.
  if (message.endsWith('unavailable') || message === 'Project sharing forbidden')
    return workspaceUnavailableResponse(request)
  throw error
}
