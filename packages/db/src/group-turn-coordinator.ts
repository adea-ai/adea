import { and, asc, eq, sql } from 'drizzle-orm'

import type { UserPrincipalRef } from '@adea-ai/types'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import {
  admissionForParticipant,
  loadGroupRoster,
  resolveGroupLeadAgentId,
} from './group-participation-store'
import { evaluateGroupGrantWindow } from './group-participation-policy'
import type { GroupAdmission } from '@adea-ai/types'
import { createLeadTurn } from './lead-turns'
import { addressedAgentTurns, type AddressedAgentTurn } from './schema/addressed-agent-turns'
import { messages, workspaceMemberships } from './schema'

export type { AddressedAgentTurn } from './schema/addressed-agent-turns'

/** Loose structural surface: the full node or an open transaction. */
export type AddressedTurnStore = Pick<
  AgentHqTransaction,
  'select' | 'insert' | 'update' | 'execute'
>

export type AddressedTurnBudget = Readonly<{
  /** Maximum recursion depth below the root turn (root is depth 0). */
  maxDepth: number
  /** Maximum claimed turns in one trigger tree. */
  maxTurns: number
}>

export const DEFAULT_ADDRESSED_TURN_BUDGET: AddressedTurnBudget = {
  maxDepth: 2,
  maxTurns: 8,
}

export type AddressedTurnClaimInput = Readonly<{
  channelId: string
  /** The human message that caused this turn; agent messages never address. */
  triggerMessageId: string
  agentId: string
  dispatchRevision: number
  /**
   * Explicit human addresser. It must equal the authenticated principal,
   * which in turn must be bound to the canonical trigger message (its
   * author, or a workspace manager) — an agent principal or a forged
   * sender is rejected before any write, which is what keeps agent
   * chatter from ever auto-dispatching follow-up turns.
   */
  addressedBy: Readonly<{ kind: 'user'; userId: string }>
  parentTurnId?: string | null
  budget?: AddressedTurnBudget
}>

export type AddressedTurnDecision =
  | Readonly<{ action: 'allow'; depth: number }>
  | Readonly<{ action: 'deny'; reason: string }>

export type AddressedTurnClaim =
  | Readonly<{ status: 'claimed'; turn: AddressedAgentTurn }>
  | Readonly<{ status: 'duplicate'; turn: AddressedAgentTurn }>

export function causalIdForAddressedTurn(
  triggerMessageId: string,
  agentId: string,
  dispatchRevision: number
): string {
  return `turn:${triggerMessageId}:${agentId}:${dispatchRevision}`
}

function asStore(database: AgentHqDatabase | AgentHqTransaction): AddressedTurnStore {
  return database as unknown as AddressedTurnStore
}

type AddresserProof = Readonly<{
  /** True when the principal authored the trigger or manages the workspace. */
  bound: boolean
  /** Effective human admission at decision time, or null. */
  admission: GroupAdmission | null
}>

async function proveAddresser(
  store: AddressedTurnStore,
  workspaceId: string,
  channelId: string,
  triggerMessageId: string,
  principal: UserPrincipalRef
): Promise<AddresserProof> {
  const [trigger] = await store
    .select({
      channelId: messages.channelId,
      senderKind: messages.senderKind,
      senderUserId: messages.senderUserId,
      workspaceId: messages.workspaceId,
    })
    .from(messages)
    .where(
      and(
        eq(messages.id, triggerMessageId),
        eq(messages.workspaceId, workspaceId),
        eq(messages.channelId, channelId)
      )
    )
    .limit(1)
  // Forged sender/message/channel combinations fail here, before writes:
  // the trigger must be a real message in this exact channel, authored by
  // a human.
  if (!trigger) throw new AddressedTurnError('turn_trigger_unknown')
  if (trigger.senderKind !== 'user' || !trigger.senderUserId)
    throw new AddressedTurnError('turn_trigger_forged')
  const roster = await loadGroupRoster(store, workspaceId, channelId)
  const admission =
    admissionForParticipant(roster, { kind: 'user', userId: principal.userId }) ?? null
  return { admission, bound: trigger.senderUserId === principal.userId }
}

async function isWorkspaceManager(
  store: AddressedTurnStore,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const [membership] = await store
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      )
    )
    .limit(1)
  return membership?.role === 'owner' || membership?.role === 'admin'
}

/**
 * Pure addressing gate. Runs before any write: the addresser must be the
 * authenticated human principal with effective participation, the Agent
 * must hold an effective enlistment (tenant-bounded by the roster
 * loader), the revision must be positive, and recursive claims must stay
 * inside the retained root budget.
 */
export function decideAddressedTurn(
  input: AddressedTurnClaimInput,
  roster: readonly GroupAdmission[],
  parent: AddressedAgentTurn | null,
  budget: AddressedTurnBudget,
  now: string,
  proof: Readonly<{ addresserEffective: boolean; addresserBound: boolean }>
): AddressedTurnDecision {
  if (input.addressedBy.kind !== 'user') return { action: 'deny', reason: 'turn_not_addressed' }
  if (!proof.addresserBound) return { action: 'deny', reason: 'turn_trigger_forged' }
  if (!proof.addresserEffective) return { action: 'deny', reason: 'turn_not_participant' }
  if (!Number.isSafeInteger(input.dispatchRevision) || input.dispatchRevision < 1)
    return { action: 'deny', reason: 'turn_revision_invalid' }
  const agentAdmission = admissionForParticipant(roster, {
    agentId: input.agentId,
    kind: 'agent',
  })
  if (!agentAdmission) return { action: 'deny', reason: 'turn_agent_not_enlisted' }
  const window = evaluateGroupGrantWindow(agentAdmission.grant, now)
  if (window === 'revoked') return { action: 'deny', reason: 'turn_agent_revoked' }
  if (window === 'expired') return { action: 'deny', reason: 'turn_agent_expired' }
  if (window === 'not_yet_issued') return { action: 'deny', reason: 'turn_agent_not_yet_issued' }
  const depth = parent ? parent.depth + 1 : 0
  if (depth > budget.maxDepth) return { action: 'deny', reason: 'turn_depth_exceeded' }
  if (parent && parent.triggerMessageId !== input.triggerMessageId)
    return { action: 'deny', reason: 'turn_trigger_mismatch' }
  if (parent && parent.channelId !== input.channelId)
    return { action: 'deny', reason: 'turn_parent_mismatch' }
  return { action: 'allow', depth }
}

async function countTriggerTree(
  store: AddressedTurnStore,
  triggerMessageId: string
): Promise<number> {
  const rows = await store
    .select({ n: sql<number>`count(*)` })
    .from(addressedAgentTurns)
    .where(eq(addressedAgentTurns.triggerMessageId, triggerMessageId))
  return Number(rows[0]?.n ?? 0)
}

async function loadTurnByTriple(
  store: AddressedTurnStore,
  workspaceId: string,
  input: AddressedTurnClaimInput
): Promise<AddressedAgentTurn | null> {
  const rows = await store
    .select()
    .from(addressedAgentTurns)
    .where(
      and(
        eq(addressedAgentTurns.workspaceId, workspaceId),
        eq(addressedAgentTurns.triggerMessageId, input.triggerMessageId),
        eq(addressedAgentTurns.agentId, input.agentId),
        eq(addressedAgentTurns.dispatchRevision, input.dispatchRevision)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

/**
 * Earliest claim for one trigger: the tree's budget root. Only this row's
 * retained bounds govern parentless claims on a live tree.
 */
async function loadTriggerRoot(
  store: AddressedTurnStore,
  triggerMessageId: string
): Promise<AddressedAgentTurn | null> {
  const rows = await store
    .select()
    .from(addressedAgentTurns)
    .where(eq(addressedAgentTurns.triggerMessageId, triggerMessageId))
    .orderBy(asc(addressedAgentTurns.createdAt), asc(addressedAgentTurns.id))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Walks a parent chain to its root (depth-bounded; chains cannot exceed the
 * recorded budget plus one). A supplied but missing parent is rejected —
 * never silently null — and a wrong-channel parent is rejected too. The
 * retained ROOT budget governs the whole tree; caller-supplied budgets on
 * recursive claims are ignored so a caller cannot escalate its own bounds.
 */
async function resolveClaimParent(
  store: AddressedTurnStore,
  workspaceId: string,
  parentTurnId: string
): Promise<{ parent: AddressedAgentTurn; budget: AddressedTurnBudget }> {
  const [parent] = await store
    .select()
    .from(addressedAgentTurns)
    .where(
      and(
        eq(addressedAgentTurns.id, parentTurnId),
        eq(addressedAgentTurns.workspaceId, workspaceId)
      )
    )
    .limit(1)
  if (!parent) throw new AddressedTurnError('turn_parent_unknown')
  let root = parent
  for (let hops = 0; hops <= parent.depth + 1; hops += 1) {
    if (!root.parentTurnId) break
    const [next] = await store
      .select()
      .from(addressedAgentTurns)
      .where(
        and(
          eq(addressedAgentTurns.id, root.parentTurnId),
          eq(addressedAgentTurns.workspaceId, workspaceId)
        )
      )
      .limit(1)
    if (!next) throw new AddressedTurnError('turn_parent_unknown')
    root = next
  }
  return { budget: { maxDepth: root.maxDepth, maxTurns: root.maxTurns }, parent }
}

/**
 * Durable claim: persists causal ID, workspace-qualified label, revision and
 * budget before any dispatch. The whole decision runs inside one transaction
 * serialized on the canonical trigger message row (`FOR UPDATE`), so the
 * count-then-insert that bounds a trigger tree is atomic across concurrent
 * claimants: distinct claims beyond the budget fail, while duplicate retries
 * — checked before the budget — still return the retained claim when full.
 */
export async function claimAddressedTurn(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: AddressedTurnClaimInput,
  options: Readonly<{ now: string; budget?: AddressedTurnBudget }> = { now: '' }
): Promise<AddressedTurnClaim> {
  if (input.addressedBy.kind !== 'user' || input.addressedBy.userId !== principal.userId)
    throw new AddressedTurnError('turn_addresser_mismatch')
  return database.transaction(async (transaction) => {
    const store = asStore(transaction)
    // Canonical serialization point: every claim for one trigger orders on
    // this row lock, so concurrent count-then-insert pairs linearize.
    const [trigger] = await store
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.triggerMessageId),
          eq(messages.workspaceId, workspaceId),
          eq(messages.channelId, input.channelId)
        )
      )
      .limit(1)
      .for('update')
    if (!trigger) throw new AddressedTurnError('turn_trigger_unknown')
    // Successive retries converge even when the budget is full: the
    // retained claim wins before any budget is consulted.
    const retained = await loadTurnByTriple(store, workspaceId, input)
    if (retained) return { status: 'duplicate', turn: retained }
    // Human addressing proof, bound to the canonical trigger in-channel.
    const { admission, bound } = await proveAddresser(
      store,
      workspaceId,
      input.channelId,
      input.triggerMessageId,
      principal
    )
    const addresserEffective = Boolean(
      admission && evaluateGroupGrantWindow(admission.grant, options.now) === 'effective'
    )
    const addresserBound = bound || (await isWorkspaceManager(store, workspaceId, principal.userId))
    // Recursive claims inherit the retained root budget, never the
    // caller-supplied one. Parentless claims on a live tree do the same:
    // only the tree's first claim sets the budget, so no caller can
    // escalate bounds by starting "fresh" on a busy trigger.
    const parent = input.parentTurnId
      ? await resolveClaimParent(store, workspaceId, input.parentTurnId)
      : null
    const treeRoot = !parent ? await loadTriggerRoot(store, input.triggerMessageId) : null
    const treeBudget = treeRoot
      ? { maxDepth: treeRoot.maxDepth, maxTurns: treeRoot.maxTurns }
      : null
    const budget =
      parent?.budget ??
      treeBudget ??
      options.budget ??
      input.budget ??
      DEFAULT_ADDRESSED_TURN_BUDGET
    const roster = await loadGroupRoster(store, workspaceId, input.channelId)
    const decision = decideAddressedTurn(
      input,
      roster,
      parent?.parent ?? null,
      budget,
      options.now,
      { addresserBound, addresserEffective }
    )
    if (decision.action === 'deny') throw new AddressedTurnError(decision.reason)
    if ((await countTriggerTree(store, input.triggerMessageId)) >= budget.maxTurns)
      throw new AddressedTurnError('turn_budget_exhausted')
    const causalId = causalIdForAddressedTurn(
      input.triggerMessageId,
      input.agentId,
      input.dispatchRevision
    )
    const inserted = await store
      .insert(addressedAgentTurns)
      .values({
        addressedLabel: `${workspaceId}:${input.agentId}`,
        agentId: input.agentId,
        causalId,
        channelId: input.channelId,
        depth: decision.depth,
        dispatchRevision: input.dispatchRevision,
        maxDepth: budget.maxDepth,
        maxTurns: budget.maxTurns,
        parentTurnId: input.parentTurnId ?? null,
        triggerMessageId: input.triggerMessageId,
        workspaceId,
      })
      .onConflictDoNothing({
        target: [
          addressedAgentTurns.triggerMessageId,
          addressedAgentTurns.agentId,
          addressedAgentTurns.dispatchRevision,
        ],
      })
      .returning()
    if (inserted[0]) return { status: 'claimed', turn: inserted[0] }
    const winner = await loadTurnByTriple(store, workspaceId, input)
    if (!winner) throw new AddressedTurnError('turn_claim_unresolved')
    return { status: 'duplicate', turn: winner }
  })
}

/**
 * Records the single response for a claimed turn through the canonical
 * publication bar: the response must be a real message in this exact
 * channel sent by the claimed Agent, and the recorder must hold effective
 * human participation right now. Arbitrary message IDs, foreign channels
 * and wrong senders fail closed; redeliveries converge on the retained
 * response.
 */
export async function recordAddressedTurnResponse(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  turnId: string,
  responseMessageId: string,
  options: Readonly<{ now: string }> = { now: '' }
): Promise<AddressedAgentTurn> {
  return database.transaction(async (transaction) => {
    const store = asStore(transaction)
    const [turn] = await store
      .select()
      .from(addressedAgentTurns)
      .where(
        and(eq(addressedAgentTurns.id, turnId), eq(addressedAgentTurns.workspaceId, workspaceId))
      )
      .limit(1)
      .for('update')
    if (!turn) throw new AddressedTurnError('turn_response_unresolved')
    const [response] = await store
      .select({
        channelId: messages.channelId,
        senderAgentId: messages.senderAgentId,
        workspaceId: messages.workspaceId,
      })
      .from(messages)
      .where(eq(messages.id, responseMessageId))
      .limit(1)
    if (
      !response ||
      response.workspaceId !== workspaceId ||
      response.channelId !== turn.channelId ||
      response.senderAgentId !== turn.agentId
    )
      throw new AddressedTurnError('turn_response_unbound')
    const roster = await loadGroupRoster(store, workspaceId, turn.channelId)
    const recorder =
      admissionForParticipant(roster, { kind: 'user', userId: principal.userId }) ?? null
    if (!recorder || evaluateGroupGrantWindow(recorder.grant, options.now) !== 'effective')
      throw new AddressedTurnError('turn_response_unauthorized')
    const updated = await store
      .update(addressedAgentTurns)
      .set({ responseMessageId, state: 'responded' })
      .where(
        and(
          eq(addressedAgentTurns.id, turnId),
          eq(addressedAgentTurns.workspaceId, workspaceId),
          eq(addressedAgentTurns.state, 'claimed')
        )
      )
      .returning()
    if (updated[0]) return updated[0]
    const [current] = await store
      .select()
      .from(addressedAgentTurns)
      .where(
        and(eq(addressedAgentTurns.id, turnId), eq(addressedAgentTurns.workspaceId, workspaceId))
      )
      .limit(1)
    if (!current) throw new AddressedTurnError('turn_response_unresolved')
    return current
  })
}

/**
 * Thin dispatch toward real Pi-backed execution through the existing
 * lead-turn adapter (partial #1179 slice: only the currently resolved group
 * lead can dispatch today; addressed non-lead turns stay claimed and a
 * second runtime is never invented here). Claims first (durable, with full
 * human proof), then dispatches with a causal idempotency key so
 * redispatch converges on one intent.
 */
export async function dispatchAddressedTurn(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: AddressedTurnClaimInput,
  options: Readonly<{ now: string; budget?: AddressedTurnBudget }> = { now: '' }
) {
  const claim = await claimAddressedTurn(database, workspaceId, principal, input, options)
  const leadAgentId = await resolveGroupLeadAgentId(
    database,
    workspaceId,
    input.channelId,
    options.now || new Date().toISOString()
  )
  if (leadAgentId !== input.agentId) throw new AddressedTurnError('turn_not_lead')
  const intent = await createLeadTurn(database, workspaceId, input.channelId, principal, {
    bodyText: `Addressed turn ${claim.turn.causalId}`,
    idempotencyKey: `turn-dispatch:${claim.turn.causalId}`,
    mentions: [],
  })
  return { claim, intent }
}

/**
 * Human priority: a newer human message supersedes still-claimed turns, so a
 * reconnect replays only live work in committed order. Responses already
 * recorded are history and stay untouched.
 */
export async function supersedeAddressedTurns(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  channelId: string
): Promise<number> {
  const store = asStore(database)
  const updated = await store
    .update(addressedAgentTurns)
    .set({ state: 'superseded' })
    .where(
      and(
        eq(addressedAgentTurns.workspaceId, workspaceId),
        eq(addressedAgentTurns.channelId, channelId),
        eq(addressedAgentTurns.state, 'claimed')
      )
    )
    .returning({ id: addressedAgentTurns.id })
  return updated.length
}

/**
 * Reconnect read: every turn for the channel in committed order with its
 * workspace-qualified label, so a rejoining participant sees exactly who
 * was addressed, what responded, and what was superseded.
 */
export async function loadAddressedTurns(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  channelId: string
): Promise<readonly AddressedAgentTurn[]> {
  const store = asStore(database)
  return store
    .select()
    .from(addressedAgentTurns)
    .where(
      and(
        eq(addressedAgentTurns.workspaceId, workspaceId),
        eq(addressedAgentTurns.channelId, channelId)
      )
    )
    .orderBy(asc(addressedAgentTurns.createdAt), asc(addressedAgentTurns.id))
}

export class AddressedTurnError extends Error {
  constructor(readonly reason: string) {
    super(`Addressed turn unavailable: ${reason}`)
    this.name = 'AddressedTurnError'
  }
}
