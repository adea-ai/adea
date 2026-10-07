import 'server-only'

import { enqueueTaskSubmission, getTaskSubmissionForUser, TaskSubmissionError } from '@adea-ai/db'

import { applicationDatabase } from './database'
import { readTaskSubmissionInput } from './task-submission-input'
import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import { isUuid, readTaskCommand } from './task-request'
import { authorizeWorkspace } from './workspace-authorization'
import { resolveWorkspacePrincipal } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

export async function handleTaskSubmission(
  request: Request,
  params: Readonly<{ taskId: string; workspaceId: string }>
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  if (!isUuid(params.workspaceId) || !isUuid(params.taskId))
    return workspaceUnavailableResponse(request)
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return workspaceUnavailableResponse(request, 401)
  if (
    !(await authorizeWorkspace(resolution.principal, 'runtime.invoke', params.workspaceId)).allowed
  )
    return workspaceUnavailableResponse(request)
  const command = request.method === 'POST' ? readTaskCommand(request, true) : null
  const input = request.method === 'POST' ? await readTaskSubmissionInput(request) : null
  if (request.method === 'POST' && (!command || !input))
    return workspaceInvalidRequestResponse(request)
  try {
    const submission =
      command && input
        ? await enqueueTaskSubmission(
            applicationDatabase(),
            params.workspaceId,
            params.taskId,
            resolution.principal,
            input,
            command
          )
        : await getTaskSubmissionForUser(
            applicationDatabase(),
            params.workspaceId,
            params.taskId,
            resolution.principal
          )
    return workspaceJsonResponse({ submission }, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    if (!(error instanceof TaskSubmissionError)) return workspaceUnavailableResponse(request, 503)
    if (error.code === 'unavailable') return workspaceUnavailableResponse(request)
    return workspaceJsonResponse(
      { code: `task_submission_${error.code}`, message: error.message },
      resolution,
      request,
      {
        status: error.code === 'invalid' ? 400 : 409,
        headers: { 'cache-control': 'private, no-store' },
      }
    )
  }
}
