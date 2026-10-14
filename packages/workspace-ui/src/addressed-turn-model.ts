import type { ApiAddressedTurn, ApiAddressedTurnInput } from '@adea-ai/api-client'
import type { AgentSummary, ChannelSummary, WorkspaceSummary } from '@adea-ai/types'

/**
 * Presentation and intent rules for addressed Agent turns in a group conversation (adea-ai/adea#1179).
 * Everything here is pure: the server decides what happened, this module only says it truthfully.
 */

const UNKNOWN_WORKSPACE = 'Another workspace'

/** An Agent as the group shows it: identity first, so a same-named Agent elsewhere is never the same row. */
export type QualifiedAgent = Readonly<{
  agentId: string
  /** The Agent's verified home workspace when this client has learned it; null when it has not. */
  workspaceId: string | null
  /** The display name when this client can resolve it, otherwise null. Never used as an identity. */
  name: string | null
  workspaceLabel: string
  /** `Name · Workspace`; an unresolved name reads `Agent <short id>` so two of them stay distinct. */
  label: string
}>

type QualifyContext = Readonly<{
  agents: ReadonlyMap<string, AgentSummary>
  workspaces: ReadonlyMap<string, string>
}>

export function qualifyContext(
  agents: readonly AgentSummary[],
  workspaces: readonly WorkspaceSummary[]
): QualifyContext {
  return {
    agents: new Map(agents.map((agent) => [agent.id, agent])),
    workspaces: new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
  }
}

function shortId(agentId: string) {
  return agentId.replaceAll('-', '').slice(0, 8)
}

export function qualifyAgent(
  agentId: string,
  homeWorkspaceId: string | null,
  context: QualifyContext
): QualifiedAgent {
  const known = context.agents.get(agentId)
  const workspaceId = homeWorkspaceId ?? known?.workspaceId ?? null
  const workspaceLabel = (workspaceId && context.workspaces.get(workspaceId)) || UNKNOWN_WORKSPACE
  const name = known?.name ?? null
  return {
    agentId,
    label: `${name ?? `Agent ${shortId(agentId)}`} · ${workspaceLabel}`,
    name,
    workspaceId,
    workspaceLabel,
  }
}

/**
 * The server binds `<home workspace>:<agent id>` to every turn. It is the only place a client learns the
 * home workspace of an Agent that is not in its own Agent list.
 */
export function parseAddressedLabel(
  label: string
): { agentId: string; workspaceId: string } | null {
  const separator = label.indexOf(':')
  if (separator <= 0 || separator === label.length - 1) return null
  return { agentId: label.slice(separator + 1), workspaceId: label.slice(0, separator) }
}

export function qualifyTurnAgent(turn: ApiAddressedTurn, context: QualifyContext): QualifiedAgent {
  const parsed = parseAddressedLabel(turn.addressedLabel)
  // The label's Agent must be the turn's Agent; a mismatch is not trusted for the home workspace.
  const home = parsed && parsed.agentId === turn.agentId ? parsed.workspaceId : null
  return qualifyAgent(turn.agentId, home, context)
}

/**
 * The group's roster as the header shows it. Home workspaces learned from retained turns fill in for
 * Agents this workspace does not list.
 */
export function groupParticipants(input: {
  channel: ChannelSummary
  context: QualifyContext
  turns: readonly ApiAddressedTurn[]
}): readonly QualifiedAgent[] {
  const homes = new Map<string, string>()
  for (const turn of input.turns) {
    const parsed = parseAddressedLabel(turn.addressedLabel)
    if (parsed && parsed.agentId === turn.agentId) homes.set(turn.agentId, parsed.workspaceId)
  }
  const seen = new Set<string>()
  const roster: QualifiedAgent[] = []
  for (const participant of input.channel.participants) {
    if (participant.kind !== 'agent' || seen.has(participant.agentId)) continue
    seen.add(participant.agentId)
    roster.push(
      qualifyAgent(participant.agentId, homes.get(participant.agentId) ?? null, input.context)
    )
  }
  return roster
}

export type AddressingMode = Readonly<{
  kind: 'none' | 'single' | 'several'
  label: string
}>

/** What the next message will do: nothing is addressed unless a recipient was chosen. */
export function addressingMode(selected: readonly QualifiedAgent[]): AddressingMode {
  if (selected.length === 0) return { kind: 'none', label: 'No Agent addressed' }
  if (selected.length === 1) return { kind: 'single', label: `Addressing ${selected[0]!.label}` }
  return { kind: 'several', label: `Addressing ${selected.length} Agents` }
}

export function audienceLabel(visibility: ChannelSummary['visibility']): string {
  return visibility === 'participants' ? 'Participants only' : 'Whole workspace'
}

export type TurnTone = 'neutral' | 'success' | 'warning' | 'info' | 'pending'

export type TurnPresentation = Readonly<{
  tone: TurnTone
  label: string
  detail: string
  /** The turn can still be cancelled. */
  live: boolean
}>

/** One honest line per state; `Not started` never reads as running. */
export function turnPresentation(turn: ApiAddressedTurn): TurnPresentation {
  switch (turn.state) {
    case 'claimed':
      return turn.dispatched
        ? {
            detail: 'Recorded and admitted. Waiting for the runtime to take it.',
            label: 'Admitted',
            live: true,
            tone: 'info',
          }
        : {
            detail:
              'Recorded as addressed to this Agent. Nothing has started: only the group’s lead runs turns today.',
            label: 'Not started',
            live: true,
            tone: 'warning',
          }
    case 'dispatching':
      return {
        detail: 'Sent to the runtime. The answer appears in the conversation when it is published.',
        label: 'Dispatched',
        live: true,
        tone: 'pending',
      }
    case 'responded':
      return {
        detail: 'This Agent’s answer was published to the conversation.',
        label: 'Answered',
        live: false,
        tone: 'success',
      }
    case 'superseded':
      return {
        detail:
          'A newer message arrived, so this turn was withdrawn. Nothing further will run for it.',
        label: 'Superseded',
        live: false,
        tone: 'neutral',
      }
    case 'cancelled':
      return {
        detail: 'This turn was cancelled. Nothing further will run for it.',
        label: 'Cancelled',
        live: false,
        tone: 'neutral',
      }
  }
}

/** How the turn was asked for, from what the durable record holds. */
export function turnOrigin(turn: ApiAddressedTurn): string {
  return turn.parentTurnId === null
    ? 'Addressed directly'
    : `Follow-up request (level ${turn.depth})`
}

/** Turns grouped under the human message that caused them, in the order the server committed them. */
export function turnsByTrigger(
  turns: readonly ApiAddressedTurn[]
): ReadonlyMap<string, readonly ApiAddressedTurn[]> {
  const grouped = new Map<string, ApiAddressedTurn[]>()
  for (const turn of turns) {
    const list = grouped.get(turn.triggerMessageId)
    if (list) list.push(turn)
    else grouped.set(turn.triggerMessageId, [turn])
  }
  return grouped
}

export type AddressingFailure = Readonly<{ retryable: boolean; text: string }>

const CONFLICT_COPY: Readonly<Record<string, string>> = {
  turn_already_responded: 'This Agent already answered.',
  turn_budget_exhausted: 'This message reached its limit of addressed turns.',
  turn_cancelled: 'This turn was cancelled.',
  turn_depth_exceeded: 'This request is nested too deeply in follow-ups.',
  turn_superseded: 'A newer message arrived first, so this Agent was not addressed.',
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined
}

/**
 * Failure copy for address and cancel. The server answers every authority failure with the same
 * "unavailable" response, so none of this text can name why: it only says what the user can do.
 */
export function addressedTurnFailure(
  error: unknown,
  action: 'address' | 'cancel'
): AddressingFailure {
  const status = httpStatus(error)
  if (status === 409) {
    const reason = (error as { reason?: unknown }).reason
    return {
      retryable: false,
      text:
        (typeof reason === 'string' ? CONFLICT_COPY[reason] : undefined) ??
        (action === 'address'
          ? 'This Agent could not be addressed.'
          : 'This turn could not be cancelled.'),
    }
  }
  if (status === 404)
    return {
      retryable: false,
      text:
        action === 'address'
          ? 'This Agent or conversation is no longer available to you.'
          : 'This turn is no longer available to you.',
    }
  if (status === 401)
    return { retryable: false, text: 'Your session ended. Sign in again, then retry.' }
  if (status !== undefined && status >= 400 && status < 500 && status !== 429)
    return {
      retryable: false,
      text:
        action === 'address'
          ? 'This Agent could not be addressed.'
          : 'This turn could not be cancelled.',
    }
  return {
    retryable: true,
    text:
      action === 'address'
        ? 'Not delivered yet. Retrying never starts a second turn for the same message.'
        : 'Cancellation did not reach the server. Try again.',
  }
}

export type AddressingIntent = Readonly<{
  agentId: string
  dispatchRevision: number
  /** The causal id suffix: the same key the server collapses duplicates on. */
  key: string
  status: 'pending' | 'failed'
  failure: AddressingFailure | null
  triggerMessageId: string
}>

export function addressingKey(input: ApiAddressedTurnInput): string {
  return `${input.triggerMessageId}:${input.agentId}:${input.dispatchRevision}`
}

/** The first dispatch of a message to an Agent. A re-address would be a later revision. */
export const FIRST_DISPATCH_REVISION = 1

export type AddressingQueue = Readonly<{
  intents: () => readonly AddressingIntent[]
  /** Queues intents for a just-sent message and works through them in the order given. */
  enqueue: (inputs: readonly ApiAddressedTurnInput[]) => Promise<void>
  /** Retries one failed intent. The request is identical, so the server converges on one turn. */
  retry: (key: string) => Promise<void>
  /** Retries every intent whose failure was transient; called when the connection returns. */
  retryTransient: () => Promise<void>
  dismiss: (key: string) => void
}>

/**
 * In-session delivery of address requests. A request is safe to repeat: the server keys a turn on
 * (message, Agent, revision) and answers a repeat with the retained turn. That is what makes retry on
 * reconnect harmless, and why the queue never invents a new revision to "force" delivery.
 */
export function createAddressingQueue(options: {
  send: (input: ApiAddressedTurnInput) => Promise<unknown>
  onChange: (intents: readonly AddressingIntent[]) => void
}): AddressingQueue {
  let intents: readonly AddressingIntent[] = []
  const inputs = new Map<string, ApiAddressedTurnInput>()
  const publish = (next: readonly AddressingIntent[]) => {
    intents = next
    options.onChange(next)
  }
  const patch = (key: string, change: Partial<AddressingIntent> | null) =>
    publish(
      intents.flatMap((intent) =>
        intent.key !== key ? [intent] : change === null ? [] : [{ ...intent, ...change }]
      )
    )
  const run = async (key: string) => {
    const input = inputs.get(key)
    if (!input) return
    patch(key, { failure: null, status: 'pending' })
    try {
      await options.send(input)
      inputs.delete(key)
      patch(key, null)
    } catch (error) {
      patch(key, { failure: addressedTurnFailure(error, 'address'), status: 'failed' })
    }
  }
  return {
    dismiss: (key) => {
      inputs.delete(key)
      patch(key, null)
    },
    enqueue: async (batch) => {
      const fresh = batch.filter((input) => !inputs.has(addressingKey(input)))
      for (const input of fresh) {
        const key = addressingKey(input)
        inputs.set(key, input)
        publish([
          ...intents,
          {
            agentId: input.agentId,
            dispatchRevision: input.dispatchRevision,
            failure: null,
            key,
            status: 'pending',
            triggerMessageId: input.triggerMessageId,
          },
        ])
      }
      for (const input of fresh) await run(addressingKey(input))
    },
    intents: () => intents,
    retry: async (key) => {
      if (intents.find((intent) => intent.key === key)?.status === 'failed') await run(key)
    },
    retryTransient: async () => {
      const keys = intents
        .filter((intent) => intent.status === 'failed' && intent.failure?.retryable)
        .map((intent) => intent.key)
      for (const key of keys) await run(key)
    },
  }
}
