import type { ApiContentRefResponse } from '@agent-hq/api-client'
import { getContentRefForUser, updateContentRef } from '@agent-hq/db'

import {
  contentRefErrorResponse,
  isContentRefUuid,
  parseContentRefUpdateInput,
} from '../../../../../../../server/content-ref-request'
import { applicationDatabase } from '../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../server/workspace-response'

export const runtime = 'nodejs'
export const OPTIONS = handleDesktopWorkspacePreflight
type Context = { params: Promise<{ contentId: string; workspaceId: string }> }

export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { contentId, workspaceId } = await params
  if (!isContentRefUuid(contentId)) return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const contentRef = await getContentRefForUser(
    applicationDatabase(),
    workspaceId,
    contentId,
    resolution.principal
  )
  if (!contentRef) return workspaceUnavailableResponse(request)
  const payload: ApiContentRefResponse = { contentRef }
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

export async function PATCH(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { contentId, workspaceId } = await params
  if (!isContentRefUuid(contentId)) return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  let input
  try {
    input = parseContentRefUpdateInput(await request.json())
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiContentRefResponse = {
      contentRef: await updateContentRef(
        applicationDatabase(),
        workspaceId,
        contentId,
        resolution.principal,
        input
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    return contentRefErrorResponse(error, resolution, request)
  }
}
