import { createFileRoute } from '@tanstack/solid-router'
import type { ApiWorkspaceInvitationAcceptResponse } from '@adea-ai/api-client'
import { acceptWorkspaceInvitation, isInvitationToken } from '@adea-ai/db'

import { applicationDatabase } from '../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../server/request-scope'
import { sharingErrorResponse } from '../../../../server/sharing-request'
import { resolveWorkspacePrincipal } from '../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../server/workspace-response'

/**
 * Accept a workspace invitation (ADR 0012). Not scoped to a workspace: the
 * token names it. Requires a signed-in account whose provider email matches
 * the invitation; temporary guests are asked to sign in first. Every refusal
 * after authentication — unknown, expired, revoked, already used by someone
 * else, or another email — answers the same 404, so a token cannot be probed.
 */
async function post(request: Request) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution || resolution.temporary) return workspaceUnavailableResponse(request, 401)
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).length !== 1 ||
    !isInvitationToken(body.token)
  )
    return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiWorkspaceInvitationAcceptResponse = await acceptWorkspaceInvitation(
      applicationDatabase(),
      resolution.principal,
      { email: resolution.email ?? null, token: body.token }
    )
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return sharingErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute('/api/workspace-invitations/accept')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => post(request)),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
