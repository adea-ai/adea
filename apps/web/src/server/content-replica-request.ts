import 'server-only'

import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'

export { parseContentReplicaUpsertInput } from './content-replica-input'

export function contentReplicaErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const message = error instanceof Error ? error.message : ''
  if (message.endsWith('conflict'))
    return workspaceJsonResponse(
      { code: 'content_replica_conflict', message: 'Content replica conflict' },
      resolution,
      request,
      { status: 409 }
    )
  if (message.endsWith('unavailable')) return workspaceUnavailableResponse(request)
  return workspaceJsonResponse(
    { code: 'invalid_request', message: 'Invalid request' },
    resolution,
    request,
    { status: 400 }
  )
}
