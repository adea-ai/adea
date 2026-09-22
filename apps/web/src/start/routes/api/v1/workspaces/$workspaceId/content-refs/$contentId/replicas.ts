import { createFileRoute } from '@tanstack/solid-router'
import type {
  ApiContentReplicaListResponse,
  ApiContentReplicaUpsertResponse,
} from '@adea-ai/api-client'
import { listContentReplicasForUser, upsertContentReplica } from '@adea-ai/db'

import { withRequestScope } from '../../../../../../../../server/request-scope'
import {
  contentReplicaErrorResponse,
  parseContentReplicaUpsertInput,
} from '../../../../../../../../server/content-replica-request'
import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'
import { isContentRefUuid } from '../../../../../../../../server/content-ref-input'

type Context = { params: { contentId: string; workspaceId: string } }

async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { contentId, workspaceId } = await params
  if (!isContentRefUuid(contentId)) return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const payload: ApiContentReplicaListResponse = {
    contentReplicas: await listContentReplicasForUser(
      applicationDatabase(),
      workspaceId,
      contentId,
      resolution.principal
    ),
  }
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

async function post(request: Request, { params }: Context) {
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
    input = parseContentReplicaUpsertInput(await request.json())
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const result = await upsertContentReplica(
      applicationDatabase(),
      workspaceId,
      contentId,
      resolution.principal,
      input
    )
    const payload: ApiContentReplicaUpsertResponse = {
      contentReplica: result.contentReplica,
      outcome: result.outcome,
    }
    return workspaceJsonResponse(payload, resolution, request, {
      status: result.outcome === 'created' ? 201 : 200,
    })
  } catch (error) {
    return contentReplicaErrorResponse(error, resolution, request)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/content-refs/$contentId/replicas'
)({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
