import type { AgentSummary, ChannelSummary } from '@adea-ai/types'
import type { ApiMessageResponse } from '@adea-ai/api-client'

/** Direct/project sessions never inherit lead admission from an unrelated Agent. */
export function isWorkspaceLeadConversation(
  channel: ChannelSummary | undefined,
  agent: AgentSummary | undefined
): boolean {
  return Boolean(
    channel?.kind === 'direct_agent' &&
    channel.lifecycleState === 'active' &&
    agent?.lifecycleState === 'active' &&
    agent.isWorkspaceLead === true &&
    channel.agentId === agent.id &&
    channel.workspaceId === agent.workspaceId
  )
}

export function messageSubmissionOutcome(
  response: ApiMessageResponse,
  stillCurrent: boolean
): Readonly<{ clearDraft: boolean }> {
  // An accepted canonical lead message can still be blocked for setup. Keep
  // its draft until the user deliberately replaces it; persistence is no start.
  return { clearDraft: stillCurrent && response.leadTurn === undefined }
}
