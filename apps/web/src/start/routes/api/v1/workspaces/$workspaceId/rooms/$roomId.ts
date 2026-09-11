import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../../../server/request-scope'
import type { ApiRoomResponse, ApiRoomUpdateInput } from '@adea-ai/api-client'
import { archiveRoom, getRoomForUser, updateRoom } from '@adea-ai/db'

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

type Context = { params: { roomId: string; workspaceId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { roomId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.read',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)
  const room = await getRoomForUser(
    applicationDatabase(),
    workspaceId,
    roomId,
    resolution.principal
  )
  if (!room) return workspaceUnavailableResponse(request)
  const payload: ApiRoomResponse = { room }
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

async function patch(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { roomId, workspaceId } = await params
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
  const input: ApiRoomUpdateInput = {}
  for (const field of ['functionKey', 'layoutRef', 'name', 'spatialRef', 'templateKey'] as const) {
    if (!(field in candidate)) continue
    const value = candidate[field]
    if ((field === 'name' || field === 'functionKey') && typeof value !== 'string') {
      return workspaceInvalidRequestResponse(request)
    }
    if (value !== null && typeof value !== 'string') return workspaceInvalidRequestResponse(request)
    Object.assign(input, { [field]: typeof value === 'string' ? value.trim() : null })
  }
  if (
    Object.keys(input).length === 0 ||
    input.name === '' ||
    input.functionKey === '' ||
    (input.name?.length ?? 0) > 80 ||
    (input.functionKey?.length ?? 0) > 80
  ) {
    return workspaceInvalidRequestResponse(request)
  }
  try {
    const payload: ApiRoomResponse = {
      room: await updateRoom(
        applicationDatabase(),
        workspaceId,
        roomId,
        resolution.principal,
        input
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    if (error instanceof Error && error.message === 'Room unavailable') {
      return workspaceUnavailableResponse(request)
    }
    throw error
  }
}

async function remove(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { roomId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'workspace.update',
    workspaceId
  )
  if (!authorization.allowed) return workspaceUnavailableResponse(request)
  try {
    await archiveRoom(applicationDatabase(), workspaceId, roomId, resolution.principal)
    return workspaceJsonResponse({ archived: true as const }, resolution, request)
  } catch (error) {
    if (error instanceof Error && error.message === 'Room unavailable') {
      return workspaceUnavailableResponse(request)
    }
    throw error
  }
}

function options(request: Request) {
  return handleDesktopWorkspacePreflight(request)
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/rooms/$roomId')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      PATCH: ({ request, params }) => withRequestScope(() => patch(request, { params })),
      DELETE: ({ request, params }) => withRequestScope(() => remove(request, { params })),
      OPTIONS: ({ request }) => withRequestScope(() => options(request)),
    },
  },
})
