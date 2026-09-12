import { createFileRoute } from '@tanstack/react-router'
import { findRuntimeNodeChallenge, rotateRuntimeNodeKeys, RuntimeNodeError } from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  withDesktopWorkspaceCors,
} from '../../../../../../../../server/desktop-workspace'
import { verifyRuntimeNodeProof } from '../../../../../../../../server/runtime-node-proof'
import { parseRuntimeNodeRotation } from '../../../../../../../../server/runtime-node-request'
import { authorizeWorkspace } from '../../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../../server/workspace-response'

/**
 * RuntimeNode registration is privileged and workspace-scoped: only a principal
 * with `runtime.invoke` (owner or admin) may read node identities or open a
 * challenge, and a missing or foreign node always gets the same generic answer
 * so a caller cannot probe for another workspace's hosts.
 */
async function authorize(request: Request, workspaceId: string) {
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return { refusal: workspaceUnavailableResponse(request, 401) } as const
  const authorization = await authorizeWorkspace(
    resolution.principal,
    'runtime.invoke',
    workspaceId
  )
  if (!authorization.allowed) return { refusal: workspaceUnavailableResponse(request) } as const
  return { resolution } as const
}

function runtimeNodeRefusalResponse(request: Request, error: unknown) {
  if (error instanceof RuntimeNodeError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'unauthorized' ? 403 : 409
    return withDesktopWorkspaceCors(
      Response.json({ code: error.code, message: error.message }, { status }),
      request
    )
  }
  return workspaceUnavailableResponse(request)
}

async function jsonBody(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

async function post(
  request: Request,
  { params }: { params: { runtimeNodeId: string; workspaceId: string } }
) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { runtimeNodeId, workspaceId } = await params
  const access = await authorize(request, workspaceId)
  if ('refusal' in access) return access.refusal

  const parsed = parseRuntimeNodeRotation(await jsonBody(request))
  if (!parsed) return workspaceInvalidRequestResponse(request)

  const database = applicationDatabase()
  const challenge = await findRuntimeNodeChallenge(database, {
    challengeId: parsed.challengeId,
    workspaceId,
  }).catch(() => null)
  if (!challenge) return workspaceUnavailableResponse(request)

  // The replacement key must prove possession of itself; a rotation signed with
  // the key being retired is exactly what this refuses.
  const verified = await verifyRuntimeNodeProof({
    challengeId: parsed.challengeId,
    nonce: challenge.nonce,
    publicKey: parsed.keys.find((key) => key.role === 'signing')!.publicKey,
    purpose: 'rotate',
    runtimeNodeId,
    signature: parsed.signature,
    workspaceId,
  })
  if (!verified) return workspaceInvalidRequestResponse(request)

  try {
    const node = await rotateRuntimeNodeKeys(database, {
      challengeId: parsed.challengeId,
      keys: parsed.keys,
      ownerUserId: access.resolution.principal.userId,
      runtimeNodeId,
      workspaceId,
    })
    return workspaceJsonResponse({ node }, access.resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return runtimeNodeRefusalResponse(request, error)
  }
}

export const Route = createFileRoute(
  '/api/v1/workspaces/$workspaceId/runtime-nodes/$runtimeNodeId/rotate'
)({
  server: {
    handlers: {
      POST: ({ request, params }) => post(request, { params }),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
