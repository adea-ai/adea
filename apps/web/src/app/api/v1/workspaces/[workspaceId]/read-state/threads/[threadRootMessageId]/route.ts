import type { ApiReadStateResponse } from '@agent-hq/api-client'
import { markThreadReadState } from '@agent-hq/db'

import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../../server/desktop-workspace'
import {
  parseReadStateInput,
  readStateErrorResponse,
} from '../../../../../../../../server/read-state-request'
import { isUuid } from '../../../../../../../../server/task-request'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

export const runtime = 'nodejs'
export const OPTIONS = handleDesktopWorkspacePreflight
type Context = { params: Promise<{ threadRootMessageId: string; workspaceId: string }> }

export async function POST(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { threadRootMessageId, workspaceId } = await params
  if (!isUuid(threadRootMessageId)) return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  let input
  try {
    input = parseReadStateInput(await request.json(), { requireChannelId: true })
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  if (!input?.channelId) return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiReadStateResponse = {
      readState: await markThreadReadState(
        applicationDatabase(),
        workspaceId,
        input.channelId,
        threadRootMessageId,
        resolution.principal,
        input.action,
        input.lastReadSequence
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    return readStateErrorResponse(error, resolution, request)
  }
}
