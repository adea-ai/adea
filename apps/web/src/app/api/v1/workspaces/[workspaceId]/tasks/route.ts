import type { ApiTaskCreateInput, ApiTaskResponse } from '@agent-hq/api-client'
import { createTask, listTasksForUser } from '@agent-hq/db'

import { applicationDatabase } from '../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../server/desktop-workspace'
import { isUuid, readTaskCommand, taskErrorResponse } from '../../../../../../server/task-request'
import { authorizeWorkspace } from '../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../server/workspace-response'

export const runtime = 'nodejs'
export const OPTIONS = handleDesktopWorkspacePreflight
type Context = { params: Promise<{ workspaceId: string }> }

export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  return workspaceJsonResponse(
    await listTasksForUser(applicationDatabase(), workspaceId, resolution.principal),
    resolution,
    request,
    { headers: { 'cache-control': 'private, no-store' } }
  )
}

export async function POST(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const command = readTaskCommand(request, false)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const candidate = body as Record<string, unknown>
  const priorities = ['low', 'normal', 'high', 'urgent'] as const
  const kinds = ['bug', 'feature', 'chore'] as const
  if (
    !command ||
    !candidate ||
    typeof candidate.title !== 'string' ||
    !candidate.title.trim() ||
    candidate.title.length > 200 ||
    Boolean(typeof candidate.objective === 'string' && candidate.objective.trim()) ===
      Boolean(isUuid(candidate.objectiveContentRefId)) ||
    (candidate.objective !== undefined &&
      (typeof candidate.objective !== 'string' ||
        !candidate.objective.trim() ||
        candidate.objective.length > 20_000)) ||
    (candidate.objectiveContentRefId !== undefined && !isUuid(candidate.objectiveContentRefId)) ||
    (candidate.priority !== undefined && !priorities.includes(candidate.priority as never)) ||
    (candidate.kind !== undefined && !kinds.includes(candidate.kind as never)) ||
    (candidate.agentId !== undefined && !isUuid(candidate.agentId)) ||
    (candidate.roomId !== undefined && !isUuid(candidate.roomId)) ||
    (candidate.dependencyIds !== undefined &&
      (!Array.isArray(candidate.dependencyIds) ||
        candidate.dependencyIds.length > 64 ||
        !candidate.dependencyIds.every(isUuid))) ||
    (candidate.artifactRefs !== undefined &&
      (!Array.isArray(candidate.artifactRefs) ||
        candidate.artifactRefs.length > 64 ||
        !candidate.artifactRefs.every(
          (value) => typeof value === 'string' && value.trim() && value.length <= 256
        ))) ||
    (candidate.controlPlaneExecutionRef !== undefined &&
      (typeof candidate.controlPlaneExecutionRef !== 'string' ||
        !candidate.controlPlaneExecutionRef.trim() ||
        candidate.controlPlaneExecutionRef.length > 256)) ||
    (candidate.controlPlaneWorkflowRef !== undefined &&
      (typeof candidate.controlPlaneWorkflowRef !== 'string' ||
        !candidate.controlPlaneWorkflowRef.trim() ||
        candidate.controlPlaneWorkflowRef.length > 256)) ||
    (candidate.conversation !== undefined &&
      (!candidate.conversation ||
        typeof candidate.conversation !== 'object' ||
        Array.isArray(candidate.conversation)))
  )
    return workspaceInvalidRequestResponse(request)
  const input = candidate as ApiTaskCreateInput
  if (
    input.conversation &&
    ![
      input.conversation.channelId,
      input.conversation.messageId,
      input.conversation.threadRootMessageId,
    ]
      .filter((value) => value !== undefined)
      .every(isUuid)
  )
    return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiTaskResponse = {
      task: await createTask(
        applicationDatabase(),
        workspaceId,
        resolution.principal,
        input,
        command
      ),
    }
    return workspaceJsonResponse(payload, resolution, request, { status: 201 })
  } catch (error) {
    return taskErrorResponse(error, resolution, request)
  }
}
