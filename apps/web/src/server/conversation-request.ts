// No `server-only` marker: Bun-run unit tests import this module directly (same pattern as
// marketplace-installation-request); the client-boundary guard keeps `src/server` out of browsers.
import type { GroupSelection } from '@adea-ai/db'
import type { ConversationParticipantRef } from '@adea-ai/types'

export { conversationErrorResponse } from './conversation-response'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isConversationUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function readConversationVersion(request: Request): number | null {
  const version = Number(request.headers.get('if-match')?.trim())
  return Number.isInteger(version) && version > 0 ? version : null
}

export function parseConversationParticipant(value: unknown): ConversationParticipantRef | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'user' && isConversationUuid(candidate.userId))
    return { kind: 'user', userId: candidate.userId }
  if (candidate.kind === 'agent' && isConversationUuid(candidate.agentId))
    return { agentId: candidate.agentId, kind: 'agent' }
  return null
}

/** The most identities one group selection may carry, humans and Agents together. */
export const GROUP_SELECTION_LIMIT = 100

/**
 * Strict wire parser for a group selection: user ids and workspace-qualified
 * Agent identities, nothing else. A selection carries no grant, id, revision
 * or time of any kind; unknown keys are rejected rather than ignored so a
 * caller can never smuggle authority through the shape. Returns null for any
 * malformed input, and an absent selection is the empty selection.
 */
export function parseGroupSelection(value: unknown): GroupSelection | null {
  if (value === undefined) return { agents: [], humans: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some((key) => key !== 'humans' && key !== 'agents')) return null
  const humans = candidate.humans === undefined ? [] : candidate.humans
  const agentInputs = candidate.agents === undefined ? [] : candidate.agents
  if (!Array.isArray(humans) || !Array.isArray(agentInputs)) return null
  if (humans.length + agentInputs.length > GROUP_SELECTION_LIMIT) return null
  if (!humans.every(isConversationUuid)) return null
  const agents: { agentId: string; workspaceId: string }[] = []
  for (const input of agentInputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const agent = input as Record<string, unknown>
    if (Object.keys(agent).some((key) => key !== 'agentId' && key !== 'workspaceId')) return null
    if (!isConversationUuid(agent.agentId) || !isConversationUuid(agent.workspaceId)) return null
    agents.push({ agentId: agent.agentId, workspaceId: agent.workspaceId })
  }
  return { agents, humans }
}
