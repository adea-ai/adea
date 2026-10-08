import 'server-only'

import type { AgentHqDatabase } from '@adea-ai/db'
import type { UserPrincipalRef } from '@adea-ai/types'
import type {
  AccountAgentDirectoryPage,
  AccountConversationInboxEntry,
  AccountConversationInboxPage,
  AccountDirectoryAgent,
  AccountDirectoryPageInput,
} from '@adea-ai/types/account-directory'

import { parseAccountDirectoryPageQuery, parseAccountResourceId } from './account-directory-input'
import type { WorkspacePrincipalResolution } from './workspace-principal'
import { workspaceJsonResponse, workspaceUnavailableResponse } from './workspace-response'

/**
 * Route-ready handlers for the account-wide directory and inbox (M11.03).
 * The database functions are injected: a route resolves the principal, then
 * calls one handler with the `@adea-ai/db` query. That keeps this module free
 * of a direct database import (the db package exports no subpaths) and makes
 * the boundary testable with stubs.
 */

export type AccountAgentDirectoryQuery = (
  database: AgentHqDatabase,
  principal: UserPrincipalRef,
  options?: Readonly<AccountDirectoryPageInput>
) => Promise<AccountAgentDirectoryPage>

export type AccountConversationInboxQuery = (
  database: AgentHqDatabase,
  principal: UserPrincipalRef,
  options?: Readonly<AccountDirectoryPageInput>
) => Promise<AccountConversationInboxPage>

export type AccountAgentLookup = (
  database: AgentHqDatabase,
  principal: UserPrincipalRef,
  agentId: string
) => Promise<AccountDirectoryAgent | null>

export type AccountConversationLookup = (
  database: AgentHqDatabase,
  principal: UserPrincipalRef,
  conversationId: string
) => Promise<AccountConversationInboxEntry | null>

function invalidRequest(resolution: WorkspacePrincipalResolution, request: Request) {
  return workspaceJsonResponse(
    { code: 'invalid_request', message: 'Invalid request' },
    resolution,
    request,
    { status: 400 }
  )
}

function accountDirectoryErrorResponse(
  error: unknown,
  resolution: WorkspacePrincipalResolution,
  request: Request
) {
  const message = error instanceof Error ? error.message : ''
  if (message.endsWith('cursor invalid')) return invalidRequest(resolution, request)
  // An account-wide list has no per-workspace "unavailable" answer: anything
  // unexpected is a server failure and stays unmapped for the 500 handler.
  console.error('[account-directory] unmapped error response', message || error)
  return workspaceJsonResponse(
    { code: 'account_directory_unavailable', message: 'Directory unavailable' },
    resolution,
    request,
    { status: 503 }
  )
}

function pageResponse<T>(payload: T, resolution: WorkspacePrincipalResolution, request: Request) {
  return workspaceJsonResponse(payload, resolution, request, {
    headers: { 'cache-control': 'private, no-store' },
  })
}

/** GET /api/v1/account/agents — authorized Agents across the account. */
export async function accountAgentDirectoryResponse(
  request: Request,
  database: AgentHqDatabase,
  resolution: WorkspacePrincipalResolution,
  query: AccountAgentDirectoryQuery
): Promise<Response> {
  const input = parseAccountDirectoryPageQuery(new URL(request.url).searchParams)
  if (!input) return invalidRequest(resolution, request)
  try {
    return pageResponse(await query(database, resolution.principal, input), resolution, request)
  } catch (error) {
    return accountDirectoryErrorResponse(error, resolution, request)
  }
}

/** GET /api/v1/account/agents/:agentId — deep-link lookup; denied is 404. */
export async function accountAgentLookupResponse(
  request: Request,
  database: AgentHqDatabase,
  resolution: WorkspacePrincipalResolution,
  lookup: AccountAgentLookup,
  agentId: string | undefined
): Promise<Response> {
  const id = parseAccountResourceId(agentId)
  if (!id) return invalidRequest(resolution, request)
  try {
    const agent = await lookup(database, resolution.principal, id)
    if (!agent) return workspaceUnavailableResponse(request)
    return pageResponse({ agent }, resolution, request)
  } catch (error) {
    return accountDirectoryErrorResponse(error, resolution, request)
  }
}

/** GET /api/v1/account/conversations — the account-wide inbox. */
export async function accountConversationInboxResponse(
  request: Request,
  database: AgentHqDatabase,
  resolution: WorkspacePrincipalResolution,
  query: AccountConversationInboxQuery
): Promise<Response> {
  const input = parseAccountDirectoryPageQuery(new URL(request.url).searchParams)
  if (!input) return invalidRequest(resolution, request)
  try {
    return pageResponse(await query(database, resolution.principal, input), resolution, request)
  } catch (error) {
    return accountDirectoryErrorResponse(error, resolution, request)
  }
}

/** GET /api/v1/account/conversations/:conversationId — deep-link lookup. */
export async function accountConversationLookupResponse(
  request: Request,
  database: AgentHqDatabase,
  resolution: WorkspacePrincipalResolution,
  lookup: AccountConversationLookup,
  conversationId: string | undefined
): Promise<Response> {
  const id = parseAccountResourceId(conversationId)
  if (!id) return invalidRequest(resolution, request)
  try {
    const conversation = await lookup(database, resolution.principal, id)
    if (!conversation) return workspaceUnavailableResponse(request)
    return pageResponse({ conversation }, resolution, request)
  } catch (error) {
    return accountDirectoryErrorResponse(error, resolution, request)
  }
}
