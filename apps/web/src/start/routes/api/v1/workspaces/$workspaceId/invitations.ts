import { createFileRoute } from '@tanstack/solid-router'
import type {
  ApiWorkspaceInvitationCreateResponse,
  ApiWorkspaceInvitationsResponse,
} from '@adea-ai/api-client'
import {
  createWorkspaceInvitation,
  isWorkspaceInvitationRole,
  listWorkspaceInvitationsForUser,
  normalizeInvitationEmail,
} from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { withRequestScope } from '../../../../../../server/request-scope'
import {
  invitationAcceptPath,
  sharingErrorResponse,
} from '../../../../../../server/sharing-request'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'

/**
 * Workspace invitations (ADR 0012). Both verbs need `membership.manage`.
 * Listing never includes tokens; creating returns the plaintext token exactly
 * once. No email is sent: the inviter copies the link.
 */
async function authorized(request: Request, workspaceId: string) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return { response: rejected }
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return { response: workspaceUnavailableResponse(request, 401) }
  if (!(await authorizeWorkspace(resolution.principal, 'membership.manage', workspaceId)).allowed)
    return { response: workspaceUnavailableResponse(request) }
  return { resolution }
}

async function get(request: Request, workspaceId: string) {
  const { resolution, response } = await authorized(request, workspaceId)
  if (!resolution) return response
  try {
    const payload: ApiWorkspaceInvitationsResponse = {
      invitations: await listWorkspaceInvitationsForUser(
        applicationDatabase(),
        workspaceId,
        resolution.principal
      ),
    }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return sharingErrorResponse(error, resolution, request)
  }
}

async function post(request: Request, workspaceId: string) {
  const { resolution, response } = await authorized(request, workspaceId)
  if (!resolution) return response
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).some((key) => key !== 'email' && key !== 'role')
  )
    return workspaceInvalidRequestResponse(request)
  const email = normalizeInvitationEmail(body.email)
  if (!email || !isWorkspaceInvitationRole(body.role))
    return workspaceInvalidRequestResponse(request)
  try {
    const created = await createWorkspaceInvitation(
      applicationDatabase(),
      workspaceId,
      resolution.principal,
      { email, role: body.role }
    )
    const payload: ApiWorkspaceInvitationCreateResponse = {
      acceptPath: invitationAcceptPath(created.token),
      invitation: created.invitation,
      token: created.token,
    }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'no-store' },
      status: 201,
    })
  } catch (error) {
    return sharingErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/invitations')({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() => get(request, params.workspaceId))
          : workspaceInvalidRequestResponse(request),
      POST: ({ request, params }) =>
        params?.workspaceId
          ? withRequestScope(() => post(request, params.workspaceId))
          : workspaceInvalidRequestResponse(request),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
