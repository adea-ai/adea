// Workspace-lead handoff supply (#1177): resolves the designated workspace
// chief-of-staff, the task-linked lead channel for one exact direct
// session, and that channel's current lead turn — through existing
// canonical services only (getWorkspaceLead, listChannels,
// getChannelLeadTurn, cancelLeadTurn on AgentHqApiClient), then maps the
// observed facts onto the handoff supply.
//
// The session↔lead relationship is the shared cloud task id: a session
// created for task-scoped work carries it, and a lead channel created for
// the same task carries it. Channels that do not reference the session's
// task are irrelevant to it — several lead conversations elsewhere never
// disable a valid explicitly linked handoff. Missing links resolve to
// explicit unresolved reasons; an ambiguous link (several channels
// referencing one task) fails closed instead of picking one. Nothing is
// invented: a session without a task id costs zero reads and attaches.
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { HandoffLeadAgent, HandoffLeadTurn } from '@adea-ai/dev-view/chat'

/** The structural client surface this resolver needs. Satisfied by the
 *  real AgentHqApiClient and by fixture fakes in tests. */
export type LeadHandoffPort = Pick<
  AgentHqApiClient,
  'getWorkspaceLead' | 'listChannels' | 'getChannelLeadTurn' | 'cancelLeadTurn'
>

export type LeadHandoffUnresolvedReason =
  | 'no-link'
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
 * Resolves the lead coordination facts linked to one exact direct session.
 * The session's cloud task id selects the channel: only an active lead
 * channel referencing that task can coordinate this session, and at most
 * one may. Every step reads a canonical service; every miss returns an
 * explicit reason instead of guessing. Callers fence late resolutions
 * with their own lifecycle guard — this function performs no caching,
 * polling, or retries.
 */
export async function resolveLeadHandoffSupply(
  port: LeadHandoffPort,
  workspaceId: string,
  sessionTaskId: string | undefined
): Promise<LeadHandoffResolution> {
  if (!sessionTaskId) return { status: 'unresolved', reason: 'no-link' }
  let lead: { id: string; isWorkspaceLead?: boolean; lifecycleState: string } | null
  try {
    lead = (await port.getWorkspaceLead(workspaceId)).lead
  } catch {
    return { status: 'unresolved', reason: 'request-failed' }
  }
  if (!lead) return { status: 'unresolved', reason: 'no-lead' }
  const leadAgent = toLeadAgent(lead)
  if (!leadAgent) return { status: 'unresolved', reason: 'lead-unavailable' }

  let channels: readonly {
    id: string
    kind: string
    agentId?: string
    taskId?: string
    lifecycleState: string
  }[]
  try {
    channels = await port.listChannels(workspaceId)
  } catch {
    return { status: 'unresolved', reason: 'request-failed', leadAgent }
  }
  const linked = channels.filter(
    (channel) =>
      channel.kind === 'direct_agent' &&
      channel.agentId === leadAgent.id &&
      channel.taskId === sessionTaskId &&
      channel.lifecycleState === 'active'
  )
  if (linked.length === 0) return { status: 'unresolved', reason: 'no-channel', leadAgent }
  if (linked.length > 1) return { status: 'unresolved', reason: 'ambiguous-channels', leadAgent }

  let turn: {
    intentId: string
    dispatchId?: string
    state: string
  } | null
  try {
    turn = (await port.getChannelLeadTurn(workspaceId, linked[0]!.id)).leadTurn
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
