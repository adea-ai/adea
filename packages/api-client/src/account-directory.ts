import type {
  AccountAgentDirectoryPage,
  AccountConversationInboxEntry,
  AccountConversationInboxPage,
  AccountDirectoryAgent,
  AccountDirectoryPageInput,
} from '@adea-ai/types/account-directory'

import { AgentHqApiClient } from './index.js'

export type ApiAccountAgentDirectoryResponse = AccountAgentDirectoryPage
export type ApiAccountAgentResponse = Readonly<{ agent: AccountDirectoryAgent }>
export type ApiAccountConversationInboxResponse = AccountConversationInboxPage
export type ApiAccountConversationResponse = Readonly<{
  conversation: AccountConversationInboxEntry
}>

function accountDirectoryQuery(input: AccountDirectoryPageInput): string {
  const params = new URLSearchParams()
  if (input.after !== undefined) params.set('after', input.after)
  // The server rejects an empty `q` outright, so the client omits an empty or
  // blank term instead of turning "clearing the search box" into a 400.
  if (input.q !== undefined && input.q.trim() !== '') params.set('q', input.q)
  if (input.includeArchived !== undefined)
    params.set('includeArchived', String(input.includeArchived))
  if (input.limit !== undefined) params.set('limit', String(input.limit))
  const query = params.toString()
  return query ? `?${query}` : ''
}

/**
 * Separate client so account-wide directory and inbox reads are loaded only
 * by the surfaces that use them (M11.03). The routes are account-scoped: no
 * workspace id is ever sent, and the server answers from the caller's own
 * memberships alone.
 */
export class AccountDirectoryApiClient extends AgentHqApiClient {
  /** Authorized Agents across every workspace the account belongs to. */
  async accountAgentDirectory(
    input: AccountDirectoryPageInput = {}
  ): Promise<ApiAccountAgentDirectoryResponse> {
    return this.request(`/v1/account/agents${accountDirectoryQuery(input)}`)
  }

  /** One Agent by stable id for account-wide deep links; denied is 404. */
  async accountAgent(agentId: string): Promise<ApiAccountAgentResponse> {
    return this.request(`/v1/account/agents/${encodeURIComponent(agentId)}`)
  }

  /** Authorized conversations across the account, inbox-ordered. */
  async accountConversationInbox(
    input: AccountDirectoryPageInput = {}
  ): Promise<ApiAccountConversationInboxResponse> {
    return this.request(`/v1/account/conversations${accountDirectoryQuery(input)}`)
  }

  /** One conversation by stable id for account-wide deep links. */
  async accountConversation(conversationId: string): Promise<ApiAccountConversationResponse> {
    return this.request(`/v1/account/conversations/${encodeURIComponent(conversationId)}`)
  }
}
