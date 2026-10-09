// Workspace-lead handoff supply (#1177): resolves the designated workspace
// chief-of-staff, its direct channel, and the channel's current lead turn
// through existing canonical services only — getWorkspaceLead,
// listChannels, getChannelLeadTurn, cancelLeadTurn on AgentHqApiClient —
// then maps the observed facts onto the dev-view handoff supply. Nothing
// is invented: a missing lead, channel, or turn resolves to an explicit
// unresolved reason, and an ambiguous lead channel fails closed instead of
// picking one. The dev surface projects these facts; lead-turn admission,
// dispatch, and cancellation stay owned by their canonical paths.
import type { AgentHqApiClient, ApiLeadTurnStatus } from '@adea-ai/api-client'
import type { HandoffLeadAgent, HandoffLeadTurn } from '@adea-ai/dev-view/chat'

/** The structural client surface this resolver needs. Satisfied by the
 *  real AgentHqApiClient and by fixture fakes in tests. */
export type LeadHandoffPort = Pick<
  AgentHqApiClient,
  'getWorkspaceLead' | 'listChannels' | 'getChannelLeadTurn' | 'cancelLeadTurn'
>

export type LeadHandoffUnresolvedReason =
  | 'no-lead'
  | 'lead-unavailable'
  | 'no-channel'
  | 'ambiguous-channels'
  | 'no-turn'
  | 'request-failed'

export type LeadHandoffResolution =
  | Readonly<{
      status: 'unresolved'
      reason: LeadHandoffUnresolvedReason
      /** The designated lead when roster resolution succeeded. */
      leadAgent?: HandoffLeadAgent
    }>
  | Readonly<{
      status: 'resolved'
      leadAgent: HandoffLeadAgent
      leadTurn?: HandoffLeadTurn
    }>

/** Lead-turn states that accept cancellation, mirroring the canonical
 *  workspace-ui leadTurnCanCancel rule. */
const CANCELLABLE_TURN_STATES: readonly string[] = [
  'starting',
  'running',
  'awaiting_input',
  'cancelling',
]

function toLeadAgent(input: {
  id: string
  isWorkspaceLead?: boolean
  lifecycleState: string
}): HandoffLeadAgent | undefined {
  if (input.isWorkspaceLead !== true || input.lifecycleState !== 'active') return undefined
  return { id: input.id, isWorkspaceLead: true, lifecycleState: 'active' }
}

/**
 * Resolves the workspace lead coordination facts for a handoff supply.
 * Every step reads a canonical service; every miss returns an explicit
 * reason instead of guessing. Callers fence late resolutions with their
 * own lifecycle guard — this function performs no caching, polling, or
 * retries.
 */
export async function resolveLeadHandoffSupply(
  port: LeadHandoffPort,
  workspaceId: string
): Promise<LeadHandoffResolution> {
  let lead: { id: string; isWorkspaceLead?: boolean; lifecycleState: string } | null
  try {
    lead = (await port.getWorkspaceLead(workspaceId)).lead
  } catch {
    return { status: 'unresolved', reason: 'request-failed' }
  }
  if (!lead) return { status: 'unresolved', reason: 'no-lead' }
  const leadAgent = toLeadAgent(lead)
  if (!leadAgent) return { status: 'unresolved', reason: 'lead-unavailable' }

  let channels: readonly { id: string; kind: string; agentId?: string; lifecycleState: string }[]
  try {
    channels = await port.listChannels(workspaceId)
  } catch {
    return { status: 'unresolved', reason: 'request-failed', leadAgent }
  }
  const leadChannels = channels.filter(
    (channel) =>
      channel.kind === 'direct_agent' &&
      channel.agentId === leadAgent.id &&
      channel.lifecycleState === 'active'
  )
  if (leadChannels.length === 0) return { status: 'unresolved', reason: 'no-channel', leadAgent }
  if (leadChannels.length > 1)
    return { status: 'unresolved', reason: 'ambiguous-channels', leadAgent }

  let turn: ApiLeadTurnStatus | null
  try {
    turn = (await port.getChannelLeadTurn(workspaceId, leadChannels[0]!.id)).leadTurn
  } catch {
    return { status: 'unresolved', reason: 'request-failed', leadAgent }
  }
  if (!turn) return { status: 'unresolved', reason: 'no-turn', leadAgent }
  return {
    status: 'resolved',
    leadAgent,
    leadTurn: {
      intentId: turn.intentId,
      agentId: leadAgent.id,
      ...(turn.dispatchId !== undefined ? { dispatchId: turn.dispatchId } : {}),
      state: turn.state as HandoffLeadTurn['state'],
      canCancel: CANCELLABLE_TURN_STATES.includes(turn.state),
    },
  }
}
