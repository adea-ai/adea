import { createFileRoute } from '@tanstack/react-router'
import {
  createRuntimeNodeChallenge,
  createRuntimeNodeExchangeCredential,
  digestExchangeCredential,
  listRuntimeNodesForUser,
  RuntimeNodeError,
} from '@adea-ai/db'

import { applicationDatabase } from '../../../../../../../server/database'
import {
  guardDesktopWorkspaceRequest,
  handleDesktopWorkspacePreflight,
  withDesktopWorkspaceCors,
} from '../../../../../../../server/desktop-workspace'
import { parseRuntimeNodeChallengeRequest } from '../../../../../../../server/runtime-node-request'
import { authorizeWorkspace } from '../../../../../../../server/workspace-authorization'
import { resolveWorkspacePrincipal } from '../../../../../../../server/workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from '../../../../../../../server/workspace-response'

/** Random, bounded one-time registration credential for a self-hosted host. */
function exchangeCredential(): string {
  return `adea_reg_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`
}

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
    return withDesktopWorkspaceCors(
      Response.json({ code: error.code, message: error.message }, { status: 409 }),
      request
    )
  }
  return workspaceUnavailableResponse(request)
}

async function get(request: Request, { params }: { params: { workspaceId: string } }) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const { workspaceId } = await params
  const access = await authorize(request, workspaceId)
  if ('refusal' in access) return access.refusal

  try {
    const nodes = await listRuntimeNodesForUser(applicationDatabase(), workspaceId)
    return workspaceJsonResponse({ nodes }, access.resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return runtimeNodeRefusalResponse(request, error)
  }
}

/**
 * Open a pairing challenge. A `remote_host` registration also receives a
 * one-time exchange credential (returned once, stored as a digest), which is
 * how a self-hosted server registers without ever becoming a user session.
 */
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
  const parsed = parseRuntimeNodeChallengeRequest(body)
  if (!parsed) return workspaceInvalidRequestResponse(request)

  const database = applicationDatabase()
  try {
    const challenge = await createRuntimeNodeChallenge(database, {
      createdByUserId: access.resolution.principal.userId,
      kind: parsed.kind,
      nonce: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
      purpose: 'pair',
      workspaceId,
    })

    let credential: string | null = null
    if (parsed.kind === 'remote_host') {
      credential = exchangeCredential()
      await createRuntimeNodeExchangeCredential(database, {
        challengeId: challenge.challengeId,
        digest: digestExchangeCredential(credential),
        workspaceId,
      })
    }

    return workspaceJsonResponse(
      { challenge, exchangeCredential: credential, node: null },
      access.resolution,
      request,
      { headers: { 'cache-control': 'private, no-store' } }
    )
  } catch (error) {
    return runtimeNodeRefusalResponse(request, error)
  }
}

export const Route = createFileRoute('/api/v1/workspaces/$workspaceId/runtime-nodes/')({
  server: {
    handlers: {
      GET: ({ request, params }) => get(request, { params: { workspaceId: params.workspaceId } }),
      POST: ({ request, params }) => post(request, { params: { workspaceId: params.workspaceId } }),
      OPTIONS: ({ request }) => handleDesktopWorkspacePreflight(request),
    },
  },
})
