import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../../server/request-scope'
import type { ApiArtifactResponse } from '@adea-ai/api-client'
import { createArtifact, listArtifactsForUser } from '@adea-ai/db'

import {
  artifactErrorResponse,
  parseArtifactCreateInput,
} from '../../../../../../server/artifact-request'
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

type Context = { params: { workspaceId: string } }
async function get(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const includeDeleted = new URL(request.url).searchParams.get('includeDeleted') === 'true'
  try {
    return workspaceJsonResponse(
      await listArtifactsForUser(applicationDatabase(), workspaceId, resolution.principal, {
        includeDeleted,
      }),
      resolution,
      request,
      { headers: { 'cache-control': 'private, no-store' } }
    )
  } catch (error) {
    return artifactErrorResponse(error, resolution, request)
  }
}

async function post(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  let input
  try {
    input = parseArtifactCreateInput(await request.json())
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiArtifactResponse = {
      artifact: await createArtifact(
        applicationDatabase(),
        workspaceId,
        resolution.principal,
        input
      ),
    }
    return workspaceJsonResponse(payload, resolution, request, { status: 201 })
  } catch (error) {
    return artifactErrorResponse(error, resolution, request)
  }
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/artifacts')({
  server: {
    handlers: {
      GET: ({ request, params }) => withRequestScope(() => get(request, { params })),
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
