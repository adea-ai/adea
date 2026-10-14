import type { UserPrincipalRef } from '@adea-ai/types'

import type { AgentHqDatabase } from './connection'
import { getChannelForUser } from './conversations'
import { getGroupMessageForUser } from './group-channels'
import {
  AddressedTurnError,
  cancelAddressedTurn,
  claimAddressedTurn,
  dispatchAddressedTurn,
  loadAddressedTurn,
  loadAddressedTurns,
  type AddressedAgentTurn,
  type GroupTurnDispatchBarrier,
} from './group-turn-coordinator'

/**
 * Product surface over the durable addressed-turn coordinator (M15.02,
 * adea-ai/adea#1179). Every entry point first proves the caller can read the
 * group right now (a revoked, expired or never-admitted principal gets the
 * same `Channel unavailable` as an unknown group) and only then reaches the
 * coordinator, which re-proves the addresser, the trigger binding and the
 * Agent's enlistment inside its own transactions. Nothing here widens
 * authority: it persists, dispatches, cancels and replays through the
 * coordinator and nothing else.
 */

export type AddressedTurnState =
  | 'claimed'
  | 'dispatching'
  | 'responded'
  | 'superseded'
  | 'cancelled'

/** The participant-visible projection of one retained turn. */
export type AddressedTurnView = Readonly<{
  id: string
  causalId: string
  channelId: string
  triggerMessageId: string
  agentId: string
  /** Workspace-qualified label bound to the Agent's verified home workspace. */
  addressedLabel: string
  /** Original human attribution. */
  addresserUserId: string
  dispatchRevision: number
  parentTurnId: string | null
  depth: number
  budget: Readonly<{ maxDepth: number; maxTurns: number }>
  state: AddressedTurnState
  /** True once a lead-turn intent was admitted for this claim. */
  dispatched: boolean
  /** The lead-turn intent, shown only to the addresser who owns it. */
  leadTurnIntentId: string | null
  responseMessageId: string | null
  createdAt: string
  updatedAt: string
}>

export function addressedTurnView(
  turn: AddressedAgentTurn,
  reader: UserPrincipalRef
): AddressedTurnView {
  return Object.freeze({
    addressedLabel: turn.addressedLabel,
    addresserUserId: turn.addresserUserId,
    agentId: turn.agentId,
    budget: Object.freeze({ maxDepth: turn.maxDepth, maxTurns: turn.maxTurns }),
    causalId: turn.causalId,
    channelId: turn.channelId,
    createdAt: turn.createdAt.toISOString(),
    depth: turn.depth,
    dispatched: turn.intentId !== null,
    dispatchRevision: turn.dispatchRevision,
    id: turn.id,
    leadTurnIntentId: turn.addresserUserId === reader.userId ? turn.intentId : null,
    parentTurnId: turn.parentTurnId,
    responseMessageId: turn.responseMessageId,
    state: turn.state as AddressedTurnState,
    triggerMessageId: turn.triggerMessageId,
    updatedAt: turn.updatedAt.toISOString(),
  })
}

type Options = Readonly<{ now?: string }>

/** The group must be an active group the caller can read now; anything else is "unavailable". */
async function requireReadableGroup(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
): Promise<void> {
  const channel = await getChannelForUser(database, workspaceId, channelId, principal)
  if (channel.kind !== 'group' || channel.lifecycleState !== 'active')
    throw new Error('Channel unavailable')
}

export type AddressGroupTurnInput = Readonly<{
  triggerMessageId: string
  agentId: string
  dispatchRevision: number
  parentTurnId?: string | null
}>

export type AddressGroupTurnResult = Readonly<{
  /** True when this call created the durable claim; false for a converged duplicate. */
  created: boolean
  /**
   * `admitted`: a lead-turn intent is bound to the claim. `not_lead`: the claim is retained but only the
   * currently resolved group lead can run today, so nothing was dispatched.
   */
  dispatch: 'admitted' | 'not_lead'
  turn: AddressedTurnView
}>

/**
 * Persist the addressed turn (causal ID, recipient, revision, budget) and dispatch it. The addresser is
 * always the authenticated principal; callers cannot name another, supply a budget, or address on behalf
 * of an Agent. Duplicate submissions and reconnects converge on the retained claim.
 */
export async function addressGroupTurn(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  input: AddressGroupTurnInput,
  options: Options & Readonly<{ barrier?: GroupTurnDispatchBarrier }> = {}
): Promise<AddressGroupTurnResult> {
  await requireReadableGroup(database, workspaceId, channelId, principal)
  const claimInput = {
    addressedBy: { kind: 'user', userId: principal.userId },
    agentId: input.agentId,
    channelId,
    dispatchRevision: input.dispatchRevision,
    parentTurnId: input.parentTurnId ?? null,
    triggerMessageId: input.triggerMessageId,
  } as const
  const coordinatorOptions = {
    ...(options.now === undefined ? null : { now: options.now }),
  }
  const claim = await claimAddressedTurn(
    database,
    workspaceId,
    principal,
    claimInput,
    coordinatorOptions
  )
  try {
    await dispatchAddressedTurn(database, workspaceId, principal, claimInput, {
      ...coordinatorOptions,
      ...(options.barrier ? { barrier: options.barrier } : null),
    })
  } catch (error) {
    if (error instanceof AddressedTurnError && error.reason === 'turn_not_lead') {
      const retained = (await loadAddressedTurn(database, workspaceId, claim.turn.id)) ?? claim.turn
      return {
        created: claim.status === 'claimed',
        dispatch: 'not_lead',
        turn: addressedTurnView(retained, principal),
      }
    }
    throw error
  }
  const retained = (await loadAddressedTurn(database, workspaceId, claim.turn.id)) ?? claim.turn
  return {
    created: claim.status === 'claimed',
    dispatch: 'admitted',
    turn: addressedTurnView(retained, principal),
  }
}

export const ADDRESSED_TURN_PAGE_LIMIT = 100
export const ADDRESSED_TURN_PAGE_MAX = 200

export type AddressedTurnPage = Readonly<{
  turns: readonly AddressedTurnView[]
  /** Pass as `after` to continue in committed order; null at the end. */
  nextAfter: string | null
}>

/**
 * Reconnect and replay read: the channel's turns in committed order, for a reader who can read the group
 * now. A turn whose trigger message the reader's join point (or lack of a sharing grant) holds back is
 * omitted entirely, so the roster of turns is never a back channel to withheld history.
 */
export async function listAddressedTurnsForUser(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  options: Options & Readonly<{ after?: string; limit?: number }> = {}
): Promise<AddressedTurnPage> {
  await requireReadableGroup(database, workspaceId, channelId, principal)
  const limit = Math.min(options.limit ?? ADDRESSED_TURN_PAGE_LIMIT, ADDRESSED_TURN_PAGE_MAX)
  if (!Number.isInteger(limit) || limit < 1) throw new AddressedTurnError('turn_cursor_invalid')
  const fence = options.now === undefined ? {} : { now: options.now }
  const readable = new Map<string, boolean>()
  const canRead = async (messageId: string) => {
    const known = readable.get(messageId)
    if (known !== undefined) return known
    const allowed = await getGroupMessageForUser(
      database,
      workspaceId,
      channelId,
      messageId,
      principal,
      fence
    ).then(
      () => true,
      () => false
    )
    readable.set(messageId, allowed)
    return allowed
  }
  const visible: AddressedAgentTurn[] = []
  for (const turn of await loadAddressedTurns(database, workspaceId, channelId))
    if (await canRead(turn.triggerMessageId)) visible.push(turn)
  let start = 0
  if (options.after !== undefined) {
    const index = visible.findIndex((turn) => turn.id === options.after)
    if (index < 0) throw new AddressedTurnError('turn_cursor_invalid')
    start = index + 1
  }
  const page = visible.slice(start, start + limit)
  const more = start + page.length < visible.length
  return {
    nextAfter: more ? (page.at(-1)?.id ?? null) : null,
    turns: page.map((turn) => addressedTurnView(turn, principal)),
  }
}

export type CancelGroupTurnResult = Readonly<{
  runtimeCancelRequested: boolean
  turn: AddressedTurnView
}>

/** Cancel one turn of this group (addresser or workspace manager); the turn must belong to the channel. */
export async function cancelGroupTurn(
  database: AgentHqDatabase,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef,
  turnId: string
): Promise<CancelGroupTurnResult> {
  await requireReadableGroup(database, workspaceId, channelId, principal)
  const turn = await loadAddressedTurn(database, workspaceId, turnId)
  if (!turn || turn.channelId !== channelId) throw new AddressedTurnError('turn_claim_unresolved')
  const outcome = await cancelAddressedTurn(database, workspaceId, principal, turnId)
  const retained = (await loadAddressedTurn(database, workspaceId, turnId)) ?? turn
  return {
    runtimeCancelRequested: outcome.runtimeCancelRequested,
    turn: addressedTurnView(retained, principal),
  }
}
