import { createFileRoute } from '@tanstack/react-router'
import {
  completeRuntimeNodeRegistration,
  findRuntimeNodeChallenge,
  RuntimeNodeError,
} from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  withDesktopWorkspaceCors,
} from '../../../../../../../server/desktop-workspace'
import {
  parseRuntimeNodeKind,
  parseRuntimeNodeRegistration,
} from '../../../../../../../server/runtime-node-request'
import { verifyRuntimeNodeProof } from '../../../../../../../server/runtime-node-proof'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../server/workspace-response'

/**
 * Complete a RuntimeNode pairing.
 *
 * The node signs the challenge the server issued for this workspace and kind, so
 * a captured signature cannot be replayed against a different node, workspace,
 * or purpose. A `remote_host` additionally spends a one-time exchange
 * credential, which is how a self-hosted host registers without ever becoming a
 * user session; the proof is verified *before* any state changes, so a bad proof
 * cannot burn that credential.
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

async function post(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const access = await authorize(request, workspaceId)
  if ('refusal' in access) return access.refusal

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  const kind = parseRuntimeNodeKind((body as Record<string, unknown>)?.kind)
  const parsed = parseRuntimeNodeRegistration(body, {
    requireExchangeCredential: kind === 'remote_host',
  })
  if (!parsed) return workspaceInvalidRequestResponse(request)

  const database = applicationDatabase()
  const challenge = await findRuntimeNodeChallenge(database, {
    challengeId: parsed.challengeId,
    workspaceId,
  }).catch(() => null)
  if (!challenge) return workspaceUnavailableResponse(request)

  // A proof that does not verify against the presented signing key is refused
  // before any state changes, including the one-time exchange credential.
  const signing = parsed.keys.find((key) => key.role === 'signing')
  const verified = await verifyRuntimeNodeProof({
    challengeId: parsed.challengeId,
    kind: parsed.kind,
    nonce: challenge.nonce,
    publicKey: signing!.publicKey,
    purpose: 'pair',
    signature: parsed.signature,
    workspaceId,
  })
  if (!verified) return workspaceInvalidRequestResponse(request)

  try {
    const node = await completeRuntimeNodeRegistration(database, {
      challengeId: parsed.challengeId,
      displayName: parsed.displayName,
      exchangeCredential: parsed.exchangeCredential,
      keys: parsed.keys,
      kind: parsed.kind,
      ownerUserId: access.resolution.principal.userId,
      platform: parsed.platform,
      softwareVersion: parsed.softwareVersion,
      trustMetadata: parsed.trustMetadata,
      workspaceId,
    })
    return workspaceJsonResponse({ node }, access.resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return runtimeNodeRefusalResponse(request, error)
  }
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/runtime-nodes/pair')({
  server: {
    handlers: {
      POST: ({ request, params }) => post(request, { params }),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
