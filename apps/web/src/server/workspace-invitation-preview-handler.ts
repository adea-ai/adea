import type { ApiWorkspaceInvitationPreviewResponse } from '@adea-ai/api-client'
import type { AgentHqDatabase } from '@adea-ai/db'
import { isInvitationToken, previewWorkspaceInvitation } from '@adea-ai/db'

import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import { sharingErrorResponse } from './sharing-request'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/**
 * Preview a workspace invitation before accepting it. It has the same gates as accepting: a
 * signed-in account (temporary guests get `401` and the page sends them through sign-in) whose
 * provider email matches the invitation. Every other refusal (unknown, expired, revoked, used by
 * someone else, another email, archived workspace) answers the same `404`, so a token cannot be
 * probed. It reads, never writes, and the token travels in the body only.
 */
export async function workspaceInvitationPreviewPost(
  request: Request,
  dependencies: Readonly<{
    database(): AgentHqDatabase
    resolvePrincipal(request: Request): Promise<WorkspacePrincipalResolution | null>
  }>
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await dependencies.resolvePrincipal(request)
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
    const payload: ApiWorkspaceInvitationPreviewResponse = await previewWorkspaceInvitation(
      dependencies.database(),
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
