import { createFileRoute } from '@tanstack/solid-router'
import { readRuntimeNode, RuntimeNodeError } from '@adea-ai/db'
import { applicationDatabase } from '../../../../../../../../server/database'
import { parseListQuery } from '../../../../../../../../server/control-plane-admin-request'
import { adminCorrelation } from '../../../../../../../../server/control-plane-client'
import { listNodeRuntimeConnections } from '../../../../../../../../server/control-plane-discovery'
import { controlPlaneScopeResolver } from '../../../../../../../../server/control-plane-scope'
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

async function get(request: Request, params: { workspaceId: string; runtimeNodeId: string }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (
    !(await authorizeWorkspace(resolution.principal, 'runtime.invoke', params.workspaceId)).allowed
  )
    return workspaceUnavailableResponse(request)
  if (!UUID.test(params.runtimeNodeId)) return workspaceUnavailableResponse(request)
  const input = parseListQuery(request)
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const result = await listNodeRuntimeConnections(input, adminCorrelation(request), {
      resolveControlPlaneScope: controlPlaneScopeResolver(params.workspaceId),
      readRegisteredNode: async () => {
        try {
          return await readRuntimeNode(
            applicationDatabase(),
            params.workspaceId,
            params.runtimeNodeId
          )
        } catch (error) {
          if (error instanceof RuntimeNodeError && error.code === 'not_found') return null
          throw error
        }
      },
    })
    return workspaceJsonResponse(result, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch {
    return workspaceUnavailableResponse(request)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/runtime-nodes/$runtimeNodeId/connections'
)({
  server: {
    handlers: {
      GET: ({ request, params }) => get(request, params),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
