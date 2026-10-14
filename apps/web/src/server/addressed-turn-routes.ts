import 'server-only'

import type {
  ApiAddressedTurnCancelResponse,
  ApiAddressedTurnPage,
  ApiAddressedTurnResponse,
} from '@adea-ai/api-client'
import { addressGroupTurn, cancelGroupTurn, listAddressedTurnsForUser } from '@adea-ai/db'

import {
  addressedTurnErrorResponse,
  addressedTurnReplayErrorResponse,
  ADDRESSED_TURN_BODY_LIMIT,
  parseAddressedTurnBody,
  parseAddressedTurnQuery,
} from './addressed-turn-request'
import { readBoundedRequestBytes } from './bounded-request-body'
import { isConversationUuid } from './conversation-request'
import { applicationDatabase } from './database'
import { guardDesktopWorkspaceRequest } from './desktop-workspace'
import { authorizeConversationWrite, authorizeWorkspace } from './workspace-authorization'
import { resolveWorkspacePrincipal } from './workspace-principal'
import {
  workspaceInvalidRequestResponse,
  workspaceJsonResponse,
  workspaceUnavailableResponse,
} from './workspace-response'

export type AddressedTurnParams = Readonly<{
  channelId: string
  turnId?: string
  workspaceId: string
}>

/**
 * Authenticated product handlers over the durable addressed-turn coordinator (M15.02, #1179).
 * Principal resolution and the workspace gate come first; the coordinator then re-proves the addresser,
 * the trigger binding and the Agent's enlistment in its own transaction, so a request that was valid when
 * it was sent but is stale by the time it runs dispatches nothing.
 */
async function authorizedPrincipal(request: Request, params: AddressedTurnParams, write: boolean) {
  if (!isConversationUuid(params.workspaceId) || !isConversationUuid(params.channelId))
    return { rejection: workspaceUnavailableResponse(request) }
  const resolution = await resolveWorkspacePrincipal(request)
  if (!resolution) return { rejection: workspaceUnavailableResponse(request, 401) }
  const allowed = write
    ? await authorizeConversationWrite(resolution.principal, params.workspaceId, {
        channelId: params.channelId,
      })
    : (await authorizeWorkspace(resolution.principal, 'workspace.read', params.workspaceId)).allowed
  if (!allowed) return { rejection: workspaceUnavailableResponse(request) }
  return { resolution }
}

export async function addressTurnRequest(request: Request, params: AddressedTurnParams) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const gate = await authorizedPrincipal(request, params, true)
  if ('rejection' in gate) return gate.rejection
  const { resolution } = gate
  const bytes = await readBoundedRequestBytes(request, ADDRESSED_TURN_BODY_LIMIT)
  let parsed: ReturnType<typeof parseAddressedTurnBody> = null
  try {
    parsed = bytes ? parseAddressedTurnBody(JSON.parse(new TextDecoder().decode(bytes))) : null
  } catch {
    parsed = null
  }
  if (!parsed) return workspaceInvalidRequestResponse(request)
  try {
    const result = await addressGroupTurn(
      applicationDatabase(),
      params.workspaceId,
      params.channelId,
      resolution.principal,
      parsed
    )
    const payload: ApiAddressedTurnResponse = {
      created: result.created,
      dispatch: result.dispatch,
      turn: result.turn,
    }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
      status: result.created ? 201 : 200,
    })
  } catch (error) {
    return addressedTurnErrorResponse(error, resolution, request)
  }
}

export async function listTurnsRequest(request: Request, params: AddressedTurnParams) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  const gate = await authorizedPrincipal(request, params, false)
  if ('rejection' in gate) return gate.rejection
  const { resolution } = gate
  const query = parseAddressedTurnQuery(new URL(request.url))
  if (!query) return workspaceInvalidRequestResponse(request)
  try {
    const page = await listAddressedTurnsForUser(
      applicationDatabase(),
      params.workspaceId,
      params.channelId,
      resolution.principal,
      query
    )
    const payload: ApiAddressedTurnPage = { nextAfter: page.nextAfter, turns: page.turns }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    // A replay failure is an error the client retries, never an empty or short page it would page past.
    return addressedTurnReplayErrorResponse(error, resolution, request)
  }
}

export async function cancelTurnRequest(request: Request, params: AddressedTurnParams) {
  const rejected = guardDesktopWorkspaceRequest(request)
  if (rejected) return rejected
  if (!isConversationUuid(params.turnId)) return workspaceUnavailableResponse(request)
  const gate = await authorizedPrincipal(request, params, true)
  if ('rejection' in gate) return gate.rejection
  const { resolution } = gate
  // Cancel carries no input: the turn is named by the path, the actor by the session. Only a body that is
  // genuinely absent reads as "no input"; an oversized, malformed-length or failed read is refused before
  // any side effect, because cancellation cannot be undone.
  const bodyless =
    request.body === null &&
    (request.headers.get('content-length') === null ||
      request.headers.get('content-length') === '0')
  const bytes = bodyless
    ? new Uint8Array(0)
    : await readBoundedRequestBytes(request, ADDRESSED_TURN_BODY_LIMIT)
  if (bytes === null) return workspaceInvalidRequestResponse(request)
  try {
    const body = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {}
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      return workspaceInvalidRequestResponse(request)
  } catch {
    return workspaceInvalidRequestResponse(request)
  }
  try {
    const result = await cancelGroupTurn(
      applicationDatabase(),
      params.workspaceId,
      params.channelId,
      resolution.principal,
      params.turnId!
    )
    const payload: ApiAddressedTurnCancelResponse = {
      runtimeCancelRequested: result.runtimeCancelRequested,
      turn: result.turn,
    }
    return workspaceJsonResponse(payload, resolution, request, {
      headers: { 'cache-control': 'private, no-store' },
    })
  } catch (error) {
    return addressedTurnErrorResponse(error, resolution, request)
  }
}
