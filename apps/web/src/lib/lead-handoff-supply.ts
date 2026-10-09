// Workspace-lead handoff supply (#1177): resolves the designated workspace
// chief-of-staff, the lead's exactly-one active task-less direct channel,
// and that channel's retained turn for one exact direct session — through
// existing canonical services only (getWorkspaceLead, listChannels,
// getChannelLeadTurn, cancelLeadTurn on AgentHqApiClient), then maps the
// observed facts onto the handoff supply.
//
// Binding is exact, never task-wide: admission opens on the lead's direct
// channel and retains the structured target (session, server-checked task visibility,
// observed generation) on the intent. Reads are target-scoped, so another
// session sharing the task — or a newer turn for it — can never display as
// this session's coordinator. A session without a task id costs zero reads
// and attaches; several lead channels fail closed instead of picking one.
import type { AgentHqApiClient } from '@adea-ai/api-client'
import type { HandoffLeadAgent, HandoffLeadTurn } from '@adea-ai/dev-view/chat'

/** The structural client surface this resolver needs. Satisfied by the
 *  real AgentHqApiClient and by fixture fakes in tests. */
export type LeadHandoffPort = Pick<
  AgentHqApiClient,
  'getWorkspaceLead' | 'listChannels' | 'getChannelLeadTurn' | 'cancelLeadTurn' | 'createMessage'
>

export type LeadHandoffUnresolvedReason =
  | 'no-link'
  | 'no-lead'
  | 'lead-unavailable'
  | 'no-channel'
  | 'ambiguous-channels'
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
      /** The exactly-one linked channel; present even with no turn yet. */
      channelId: string
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

export function leadTurnCanCancel(state: string): boolean {
  return CANCELLABLE_TURN_STATES.includes(state)
}

function toLeadAgent(input: {
  id: string
  isWorkspaceLead?: boolean
  lifecycleState: string
}): HandoffLeadAgent | undefined {
  if (input.isWorkspaceLead !== true || input.lifecycleState !== 'active') return undefined
  return { id: input.id, isWorkspaceLead: true, lifecycleState: 'active' }
}

/**
 * Monotonic ordering scope for overlapping async resolutions. Each new
 * resolution attempt (or invalidating mutation) begins an epoch; a
 * completion applies only while its epoch is still current. This is what
 * keeps a slow older read from overwriting a newer one for the same
 * session, and what drops superseded selections without session-id
 * round-trips. Shared by production and fixture hosts so the mounted
 * out-of-order regression exercises the real primitive.
 */
export function createOrderedScope(): {
  begin: () => number
  current: () => number
  isCurrent: (captured: number) => boolean
} {
  let epoch = 0
  return {
    begin: () => {
      epoch += 1
      return epoch
    },
    current: () => epoch,
    isCurrent: (captured: number) => captured === epoch,
  }
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
  sessionTaskId: string | undefined,
  sessionRef?: Readonly<{ runtimeSessionId: string }>
): Promise<LeadHandoffResolution> {
  if (!sessionTaskId || !sessionRef) return { status: 'unresolved', reason: 'no-link' }
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
  // Admission opens only on the lead's task-less direct channel: task-scoped
  // channels cannot admit, so they can never coordinate either.
  const linked = channels.filter(
    (channel) =>
      channel.kind === 'direct_agent' &&
      channel.agentId === leadAgent.id &&
      (channel.taskId === undefined || channel.taskId === null) &&
      channel.lifecycleState === 'active'
  )
  if (linked.length === 0) return { status: 'unresolved', reason: 'no-channel', leadAgent }
  if (linked.length > 1) return { status: 'unresolved', reason: 'ambiguous-channels', leadAgent }

  let turn: {
    intentId: string
    dispatchId?: string
    state: string
    handoffTarget?: {
      runtimeSessionId: string
      taskId?: string
      observedGeneration: number
    }
    /** Runtime-validated execution binding, when the runtime observed one. */
    runtimeSessionId?: string
    /** Control-plane-reported execution observation, when a live display
     *  read returned one. Displayed for owner comparison only — never
     *  authority, never carrying a generation. */
    observedTarget?: {
      sessionId: string
      taskId: string
    }
  } | null
  try {
    turn = (await port.getChannelLeadTurn(workspaceId, linked[0]!.id, sessionRef.runtimeSessionId))
      .leadTurn
  } catch {
    return { status: 'unresolved', reason: 'request-failed', leadAgent }
  }
  const channelId = linked[0]!.id
  if (!turn) return { status: 'resolved', leadAgent, channelId }
  // Defense in depth: the read is already target-scoped server-side; a
  // mistargeted turn never becomes supply even if it arrives here.
  if (turn.handoffTarget?.runtimeSessionId !== sessionRef.runtimeSessionId)
    return { status: 'resolved', leadAgent, channelId }
  return {
    status: 'resolved',
    leadAgent,
    channelId,
    leadTurn: {
      intentId: turn.intentId,
      agentId: leadAgent.id,
      ...(turn.dispatchId !== undefined ? { dispatchId: turn.dispatchId } : {}),
      state: turn.state as HandoffLeadTurn['state'],
      canCancel: leadTurnCanCancel(turn.state),
      // Execution location, never authority: mapped through so the
      // derivation can name where the lead runs while refusing
      // coordination without an explicit target-bound observation.
      ...(turn.runtimeSessionId !== undefined
        ? { executionRuntimeSessionId: turn.runtimeSessionId }
        : {}),
      ...(turn.observedTarget !== undefined &&
      typeof turn.observedTarget.sessionId === 'string' &&
      typeof turn.observedTarget.taskId === 'string'
        ? {
            observedTarget: {
              sessionId: turn.observedTarget.sessionId,
              taskId: turn.observedTarget.taskId,
            },
          }
        : {}),
      handoffTarget: {
        runtimeSessionId: turn.handoffTarget.runtimeSessionId,
        ...(turn.handoffTarget.taskId !== undefined ? { taskId: turn.handoffTarget.taskId } : {}),
        observedGeneration: turn.handoffTarget.observedGeneration,
      },
    },
  }
}

/**
 * Builds the explicit handoff request body: a human-readable admission
 * sentence naming the exact target session. The machine linkage lives in
 * the retained receipt plus the channel it posts to — never parsed out of
 * prose. The shape is fixed so retries reuse it byte-for-byte under a
 * stable idempotency key.
 */
export function buildHandoffRequestBody(runtimeSessionId: string): string {
  return `Requesting lead coordination for direct session ${runtimeSessionId}.`
}

export type LeadHandoffRequest = Readonly<{
  intentId: string
  messageId: string
  channelId: string
  handoffTarget: Readonly<{
    runtimeSessionId: string
    taskId?: string
    observedGeneration: number
  }>
}>

/**
 * Requests lead coordination through the canonical admission path: one
 * message with `leadTurn: true` plus the structured handoff target on the
 * linked direct channel, fenced by the server's channel-write, lead-turn,
 * and task-visibility authorization. The response receipt carries the
 * admitted intent with its retained target, and the target is checked to
 * match the request — a missing or mistargeted receipt is a failed
 * admission, never a silent success.
 *
 * No client-held request identity: every attempt mints a fresh
 * idempotency key, and unknown-outcome retries recover the canonically
 * retained intent server-side (same target and generation dedupes, a newer
 * retained generation rejects the stale request). Eviction and reload
 * cannot lose the binding because the binding never lived client-side.
 */
export async function requestLeadHandoff(
  port: LeadHandoffPort,
  input: Readonly<{
    workspaceId: string
    channelId: string
    runtimeSessionId: string
    taskId: string
    expectedGeneration: number
  }>
): Promise<LeadHandoffRequest> {
  const response = await port.createMessage(input.workspaceId, input.channelId, {
    leadTurn: true,
    bodyText: buildHandoffRequestBody(input.runtimeSessionId),
    handoffTarget: {
      runtimeSessionId: input.runtimeSessionId,
      taskId: input.taskId,
      expectedGeneration: input.expectedGeneration,
    },
    idempotencyKey: crypto.randomUUID(),
  })
  const receipt = response.leadTurn
  const messageId = response.message?.id
  const target = receipt?.handoffTarget
  if (!receipt || !messageId || !target) throw new Error('Lead admission did not return an intent')
  if (
    target.runtimeSessionId !== input.runtimeSessionId ||
    (target.taskId ?? undefined) !== input.taskId ||
    target.observedGeneration !== input.expectedGeneration
  )
    throw new Error('Lead admission returned another target')
  return {
    intentId: receipt.intentId,
    messageId,
    channelId: input.channelId,
    handoffTarget: {
      runtimeSessionId: target.runtimeSessionId,
      ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
      observedGeneration: target.observedGeneration,
    },
  }
}
