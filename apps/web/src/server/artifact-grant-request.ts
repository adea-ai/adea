import 'server-only'

import {
  ArtifactReferenceGrantError,
  type ArtifactReferenceGrantRegistrationInput,
  type ArtifactReferenceGrantRejectionCode,
} from '@adea-ai/db'
import type { ArtifactReferenceGrantState } from '@adea-ai/types'

import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/**
 * HTTP boundary for artifact-reference sharing grants (#1216). The grant store
 * decides every authority question from the database: the issuer's role in the
 * granting workspace, both workspaces' liveness, the artifact's canonical
 * version and digest, and the grant's revision and revocation. This module only
 * parses the request and maps the store's typed refusals onto responses. It never
 * supplies authority, and it never reads grant state the store did not return.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/
const GRANT_ID_MAX_LENGTH = 128
const BODY_LIMIT_BYTES = 4_096
const REGISTRATION_KEYS = [
  'artifactId',
  'audienceWorkspaceId',
  'checksumSha256',
  'expiresAt',
  'grantId',
  'version',
] as const

export type ArtifactGrantRegistrationRequest = Readonly<{
  expectedRevision?: number
  input: ArtifactReferenceGrantRegistrationInput
}>

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Reads a bounded JSON object. Resolves to null when the body is absent, too
 * large, not JSON, or not an object, so every malformed body takes one refusal.
 */
export async function readArtifactGrantBody(
  request: Request
): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > BODY_LIMIT_BYTES) return null
  let text: string
  try {
    text = await request.text()
  } catch {
    return null
  }
  if (new TextEncoder().encode(text).byteLength > BODY_LIMIT_BYTES) return null
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Parses a registration body, or a regrant body when `regrant` is set. Every key
 * must be known and every field well-formed. Field semantics (existence,
 * canonicality, lifetime parsing) belong to the store and are not repeated here.
 */
export function parseArtifactGrantRegistration(
  body: Record<string, unknown>,
  options: Readonly<{ regrant: boolean }>
): ArtifactGrantRegistrationRequest | null {
  const allowed: readonly string[] = options.regrant
    ? [...REGISTRATION_KEYS, 'expectedRevision']
    : REGISTRATION_KEYS
  if (Object.keys(body).some((key) => !allowed.includes(key))) return null
  const { artifactId, audienceWorkspaceId, checksumSha256, expiresAt, grantId, version } = body
  if (
    typeof artifactId !== 'string' ||
    !UUID.test(artifactId) ||
    typeof audienceWorkspaceId !== 'string' ||
    !UUID.test(audienceWorkspaceId) ||
    typeof checksumSha256 !== 'string' ||
    !DIGEST.test(checksumSha256) ||
    (expiresAt !== null && typeof expiresAt !== 'string') ||
    typeof grantId !== 'string' ||
    !grantId.trim() ||
    grantId.length > GRANT_ID_MAX_LENGTH ||
    !positiveInteger(version)
  )
    return null
  const input: ArtifactReferenceGrantRegistrationInput = {
    artifactId,
    audienceWorkspaceId,
    checksumSha256,
    expiresAt,
    grantId,
    version,
  }
  if (!options.regrant) return { input }
  const { expectedRevision } = body
  if (!positiveInteger(expectedRevision)) return null
  return { expectedRevision, input }
}

/**
 * What a caller may see of a grant. The granting workspace sees the grant's full
 * identity. The audience sees only its revision and revocation mark, so a
 * receiving workspace cannot learn the artifact, digest, or source of a grant
 * it did not issue.
 */
export function artifactGrantView(state: ArtifactReferenceGrantState, callerWorkspaceId: string) {
  if (state.sourceWorkspaceId === callerWorkspaceId) return state
  return { grantId: state.grantId, revision: state.revision, revoked: state.revoked }
}

const UNAVAILABLE: ReadonlySet<ArtifactReferenceGrantRejectionCode> = new Set([
  'grant_issuer_unauthorized',
  'grant_unavailable',
  'grant_workspace_inactive',
])
const NOT_FOUND: ReadonlySet<ArtifactReferenceGrantRejectionCode> = new Set([
  'grant_artifact_unknown',
  'grant_not_registered',
])

/**
 * Maps a grant-store refusal onto a response. A refusal of authority answers like
 * an unavailable workspace, as the other workspace routes do. Anything that is
 * not a typed grant refusal is rethrown, so it surfaces as a server error.
 */
export function artifactGrantErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  if (!(error instanceof ArtifactReferenceGrantError)) throw error
  if (UNAVAILABLE.has(error.code)) return workspaceUnavailableResponse(request)
  if (error.code === 'grant_identity_invalid') return workspaceInvalidRequestResponse(request)
  return workspaceJsonResponse({ code: error.code, message: error.message }, resolution, request, {
    status: NOT_FOUND.has(error.code) ? 404 : 409,
  })
}
