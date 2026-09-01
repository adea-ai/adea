import 'server-only'

import type { ApiArtifactCreateInput } from '@agent-hq/api-client'
import { isPrincipalRef } from '@agent-hq/types'

import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHECKSUM = /^[0-9a-f]{64}$/i
const AVAILABILITY = new Set(['pending', 'available', 'unavailable', 'quarantined', 'failed'])
const RETENTION = new Set(['ephemeral', 'standard', 'retain'])
const SENSITIVITY = new Set(['workspace', 'sensitive', 'restricted'])
const LOCATION_TYPES = new Set(['object_store', 'runtime_node', 'external_harness'])

export function isArtifactUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function readArtifactVersion(request: Request): number | null {
  const version = Number(request.headers.get('if-match')?.trim())
  return Number.isInteger(version) && version > 0 ? version : null
}

export function parseArtifactCreateInput(value: unknown): ApiArtifactCreateInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const location = input.location as Record<string, unknown> | undefined
  if (
    typeof input.filename !== 'string' ||
    !input.filename.trim() ||
    input.filename.length > 255 ||
    typeof input.mediaType !== 'string' ||
    input.mediaType.length > 255 ||
    typeof input.sourceArtifactRef !== 'string' ||
    !input.sourceArtifactRef.trim() ||
    input.sourceArtifactRef.length > 512 ||
    !CHECKSUM.test(String(input.checksumSha256 ?? '')) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    Number(input.sizeBytes) < 0 ||
    !isPrincipalRef(input.sourcePrincipal) ||
    !location ||
    typeof location !== 'object' ||
    !LOCATION_TYPES.has(String(location.type)) ||
    typeof location.reference !== 'string' ||
    !location.reference.trim() ||
    location.reference.length > 1024 ||
    (input.agentId !== undefined && !isArtifactUuid(input.agentId)) ||
    (input.taskId !== undefined && !isArtifactUuid(input.taskId)) ||
    (input.executionRef !== undefined &&
      (typeof input.executionRef !== 'string' || input.executionRef.length > 512)) ||
    (input.availability !== undefined && !AVAILABILITY.has(String(input.availability))) ||
    (input.retentionPolicy !== undefined && !RETENTION.has(String(input.retentionPolicy))) ||
    (input.sensitivity !== undefined && !SENSITIVITY.has(String(input.sensitivity))) ||
    (input.provenance !== undefined &&
      (!input.provenance || typeof input.provenance !== 'object' || Array.isArray(input.provenance)))
  )
    return null
  if (input.provenance && JSON.stringify(input.provenance).length > 32_768) return null
  return input as ApiArtifactCreateInput
}

export function artifactErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const message = error instanceof Error ? error.message : ''
  if (message.endsWith('version conflict') || message.endsWith('source conflict'))
    return workspaceJsonResponse({ code: 'artifact_conflict', message }, resolution, request, {
      status: 409,
    })
  if (message.endsWith('unavailable')) return workspaceUnavailableResponse(request)
  return workspaceJsonResponse(
    { code: 'invalid_request', message: 'Invalid request' },
    resolution,
    request,
    { status: 400 }
  )
}
