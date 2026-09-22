import 'server-only'

import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'
import { classifyContentReplicaError } from './content-replica-error-classification'

export { parseContentReplicaUpsertInput } from './content-replica-input'

export function contentReplicaErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const classification = classifyContentReplicaError(error)
  if (classification === 'conflict')
    return workspaceJsonResponse(
      { code: 'content_replica_conflict', message: 'Content replica conflict' },
      resolution,
      request,
      { status: 409 }
    )
  if (classification === 'unavailable') return workspaceUnavailableResponse(request)
  if (classification === 'retryable')
    return workspaceJsonResponse(
      { code: 'content_replica_unavailable', message: 'Content replica temporarily unavailable' },
      resolution,
      request,
      { status: 503 }
    )
  return workspaceJsonResponse(
    { code: 'invalid_request', message: 'Invalid request' },
    resolution,
    request,
    { status: 400 }
  )
}
