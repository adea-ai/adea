import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../../server/request-scope'
import type { ApiRoomCreateInput, ApiRoomResponse } from '@adea-ai/api-client'
import { createRoom, listRoomsForUser } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'
async function get(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.read',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)
  const result = await listRoomsForUser(applicationDatabase(), workspaceId, resolution.principal)
  return workspaceJsonResponse(result, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

async function post(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.update',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const candidate = body as Record<string, unknown>
  const input: ApiRoomCreateInput = {
    functionKey: typeof candidate.functionKey === 'string' ? candidate.functionKey.trim() : '',
    name: typeof candidate.name === 'string' ? candidate.name.trim() : '',
    ...(typeof candidate.layoutRef === 'string' ? { layoutRef: candidate.layoutRef.trim() } : {}),
    ...(typeof candidate.spatialRef === 'string'
      ? { spatialRef: candidate.spatialRef.trim() }
      : {}),
    ...(typeof candidate.templateKey === 'string'
      ? { templateKey: candidate.templateKey.trim() }
      : {}),
  }
  if (
    !input.name ||
    input.name.length > 80 ||
    !input.functionKey ||
    input.functionKey.length > 80
  ) {
    return workspaceInvalidRequestResponse(request)
  }
  const payload: ApiRoomResponse = {
    room: await createRoom(applicationDatabase(), workspaceId, resolution.principal, input),
  }
  return workspaceJsonResponse(payload, resolution, request, { status: 201 })
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/rooms')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
