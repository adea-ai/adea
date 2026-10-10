import 'server-only'

import {
  type AgentHqDatabase,
  exportPortableWorkspace,
  type PortableExportHooks,
  importPortableWorkspace,
  PortableExportError,
  PortableImportError,
} from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'

import { isConversationUuid } from './conversation-request'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

/**
 * The largest portable bundle the API will read or emit. A bundle over the bound
 * is refused, never truncated, so every exported workspace can also be imported
 * through the same API.
 */
export const PORTABLE_API_MAX_BYTES = 8 * 1024 * 1024

/** Issues are capped so one malformed bundle cannot produce an unbounded error body. */
const MAX_REPORTED_ISSUES = 50

const NO_STORE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
} as const

function portableErrorResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    headers: { ...NO_STORE_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    status,
  })
}

/**
 * Read a request body with a hard byte bound. A declared length over the bound
 * is refused before any byte is read; an undeclared or understated length is
 * still refused as soon as the stream crosses the bound.
 */
async function readBoundedJson(
  request: Request,
  limit: number
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    return { ok: false, status: 413 }
  if (!request.body) return { ok: false, status: 400 }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return { ok: false, status: 413 }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  } catch {
    return { ok: false, status: 400 }
  }
}

/**
 * GET the requester's portable export of one workspace. Non-members, removed
 * members and deleted or being-deleted workspaces all receive the same
 * "unavailable" response, so the endpoint never reveals that a workspace exists.
 */
export async function portableWorkspaceExportResponse(
  request: Request,
  database: AgentHqDatabase,
  resolution: WorkspacePrincipalResolution,
  workspaceId: string,
  options: Readonly<{ hooks?: PortableExportHooks }> = {}
) {
  if (!isConversationUuid(workspaceId)) return workspaceInvalidRequestResponse(request)
  try {
    const document = await exportPortableWorkspace(database, {
      hooks: options.hooks,
      principal: resolution.principal,
      workspaceId,
    })
    const size = new TextEncoder().encode(JSON.stringify(document)).byteLength
    if (size > PORTABLE_API_MAX_BYTES)
      return portableErrorResponse(413, { error: 'too_large', maxBytes: PORTABLE_API_MAX_BYTES })
    return workspaceJsonResponse(document, resolution, request, {
      headers: {
        ...NO_STORE_HEADERS,
        'content-disposition': `attachment; filename="workspace-${workspaceId}.portable.json"`,
      },
    })
  } catch (error) {
    if (error instanceof PortableExportError && error.code === 'denied')
      return workspaceUnavailableResponse(request)
    if (error instanceof PortableExportError && error.code === 'too_large')
      return portableErrorResponse(413, { error: 'too_large', maxBytes: PORTABLE_API_MAX_BYTES })
    throw error
  }
}

/**
 * POST a portable bundle to restore it as a new workspace owned by the caller.
 * The caller must be allowed to create workspaces (the same check workspace
 * creation applies). The bundle grants nothing: the caller becomes the owner,
 * and every referenced user must already exist in this destination.
 */
export async function portableImportResponse(
  request: Request,
  database: AgentHqDatabase,
  resolution: WorkspacePrincipalResolution,
  mayCreateWorkspace: (principal: UserPrincipalRef) => Promise<boolean>
) {
  if (!(await mayCreateWorkspace(resolution.principal)))
    return workspaceUnavailableResponse(request)
  const read = await readBoundedJson(request, PORTABLE_API_MAX_BYTES)
  if (!read.ok)
    return read.status === 413
      ? portableErrorResponse(413, { error: 'too_large', maxBytes: PORTABLE_API_MAX_BYTES })
      : workspaceInvalidRequestResponse(request)
  try {
    const result = await importPortableWorkspace(database, {
      bundle: read.value,
      importer: resolution.principal,
    })
    return workspaceJsonResponse(result, resolution, request, {
      headers: NO_STORE_HEADERS,
      status: 201,
    })
  } catch (error) {
    if (!(error instanceof PortableImportError)) throw error
    const issues = error.issues.slice(0, MAX_REPORTED_ISSUES)
    switch (error.code) {
      case 'invalid_document':
      case 'digest_mismatch':
        return portableErrorResponse(422, { error: error.code, issues })
      case 'unresolved_users':
        return portableErrorResponse(422, { error: error.code, message: error.message })
      case 'importer_unavailable':
        return portableErrorResponse(403, { error: error.code })
      case 'target_exists':
        return portableErrorResponse(409, { error: error.code })
      case 'verification_failed':
        return portableErrorResponse(500, { error: error.code })
    }
  }
}
