import type { ApiTaskResponse, ApiTaskUpdateInput } from '@adea-ai/api-client'
import { getTaskForUser, updateTask } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
} from '../../../../../../../server/desktop-workspace'
import {
  isUuid,
  readTaskCommand,
  taskErrorResponse,
} from '../../../../../../../server/task-request'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../server/workspace-response'

export const runtime = 'nodejs'
export const OPTIONS = handleDesktopWorkspacePreflight
type Context = { params: Promise<{ taskId: string; workspaceId: string }> }

export async function GET(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { taskId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.read', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const task = await getTaskForUser(
    applicationDatabase(),
    workspaceId,
    taskId,
    resolution.principal
  )
  if (!task) return workspaceUnavailableResponse(request)
  return workspaceJsonResponse({ task }, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

export async function PATCH(request: Request, { params }: Context) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { taskId, workspaceId } = await params
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (!(await authorizeWorkspace(resolution.principal, 'workspace.update', workspaceId)).allowed)
    return workspaceUnavailableResponse(request)
  const command = readTaskCommand(request, true)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const input = body as ApiTaskUpdateInput
  const priorities = ['low', 'normal', 'high', 'urgent']
  const kinds = ['bug', 'feature', 'chore']
  if (
    !command ||
    !input ||
    !Object.keys(input).length ||
    (input.title !== undefined &&
      (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)) ||
    (input.objective !== undefined &&
      (typeof input.objective !== 'string' ||
        !input.objective.trim() ||
        input.objective.length > 20_000)) ||
    (input.objectiveContentRefId !== undefined && !isUuid(input.objectiveContentRefId)) ||
    (input.objective !== undefined && input.objectiveContentRefId !== undefined) ||
    (input.priority !== undefined && !priorities.includes(input.priority)) ||
    (input.kind !== undefined && !kinds.includes(input.kind)) ||
    (input.controlPlaneExecutionRef !== undefined &&
      input.controlPlaneExecutionRef !== null &&
      (typeof input.controlPlaneExecutionRef !== 'string' ||
        !input.controlPlaneExecutionRef.trim() ||
        input.controlPlaneExecutionRef.length > 256)) ||
    (input.controlPlaneWorkflowRef !== undefined &&
      input.controlPlaneWorkflowRef !== null &&
      (typeof input.controlPlaneWorkflowRef !== 'string' ||
        !input.controlPlaneWorkflowRef.trim() ||
        input.controlPlaneWorkflowRef.length > 256))
  )
    return workspaceInvalidRequestResponse(request)
  try {
    const payload: ApiTaskResponse = {
      task: await updateTask(
        applicationDatabase(),
        workspaceId,
        taskId,
        resolution.principal,
        input,
        command
      ),
    }
    return workspaceJsonResponse(payload, resolution, request)
  } catch (error) {
    return taskErrorResponse(error, resolution, request)
  }
}
