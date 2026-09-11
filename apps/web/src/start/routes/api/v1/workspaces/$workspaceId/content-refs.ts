import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../../../server/request-scope'
import type { ApiContentRefResponse } from '@adea-ai/api-client'
import { createContentRef } from '@adea-ai/db'

import {
  contentRefErrorResponse,
  parseContentRefCreateInput,
} from '../../../../../../server/content-ref-request'
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
    input = parseContentRefCreateInput(await request.json())
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!input) return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiContentRefResponse = {
      contentRef: await createContentRef(
        applicationDatabase(),
        workspaceId,
        resolution.principal,
        input
      ),
    }
    return workspaceJsonResponse(payload, resolution, request, { status: 201 })
  } catch (error) {
    return contentRefErrorResponse(error, resolution, request)
  }
}
export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/content-refs')({
  server: {
    handlers: {
      POST: ({ request, params }) => withRequestScope(() => post(request, { params })),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
