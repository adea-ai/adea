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
import { admitAddressedLeadTurn } from './lead-turns'
import { requestLeadTurnCancellation } from './lead-turn-runtime'
import { addressedAgentTurns, type AddressedAgentTurn } from './schema/addressed-agent-turns'
import { agents, channels, messages, workspaceMemberships } from './schema'

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

function isAgentHqDatabase(
  database: AgentHqDatabase | AgentHqTransaction
): database is AgentHqDatabase {
  return typeof (database as AgentHqDatabase).transaction === 'function'
}

type AddresserProof = Readonly<{
  /** True when the principal authored the trigger or manages the workspace. */
  bound: boolean
  /** Effective human admission at decision time, or null. */
  admission: GroupAdmission | null
  /** Roster the admission was read from, reused by the decision. */
  roster: readonly GroupAdmission[]
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
  return { admission, bound: trigger.senderUserId === principal.userId, roster }
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
    // retained claim wins before any budget is consulted. Authorization
    // is revalidated FIRST, though — a revoked or forged principal never
    // obtains even a duplicate turn.
    const { admission, bound, roster } = await proveAddresser(
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
    const retained = await loadTurnByTriple(store, workspaceId, input)
    if (retained) {
      if (!addresserBound) throw new AddressedTurnError('turn_trigger_forged')
      if (!addresserEffective) throw new AddressedTurnError('turn_not_participant')
      return { status: 'duplicate', turn: retained }
    }
    // (Proof already ran above, before the duplicate short-circuit.)
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
    const decision = decideAddressedTurn(
      input,
      roster,
      parent?.parent ?? null,
      budget,
      options.now,
      { addresserBound, addresserEffective }
    )
    // (Roster already loaded by the proof above; reused, not re-read.)
    if (decision.action === 'deny') throw new AddressedTurnError(decision.reason)
    if ((await countTriggerTree(store, input.triggerMessageId)) >= budget.maxTurns)
      throw new AddressedTurnError('turn_budget_exhausted')
    // The label binds the VERIFIED source workspace from the registry —
    // never the conversation host. A foreign Agent keeps its home label
    // while the row's workspace column keeps host ownership.
    const [agentHome] = await store
      .select({ workspaceId: agents.workspaceId })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1)
    if (!agentHome) throw new AddressedTurnError('agent_unknown')
    const causalId = causalIdForAddressedTurn(
      input.triggerMessageId,
      input.agentId,
      input.dispatchRevision
    )
    const inserted = await store
      .insert(addressedAgentTurns)
      .values({
        addressedLabel: `${agentHome.workspaceId}:${input.agentId}`,
        addresserUserId: principal.userId,
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
 * Records the single response for a claimed or dispatched turn through the
 * canonical publication bar: the response must be a real message in this
 * exact channel sent by the claimed Agent, and the recorder must hold
 * effective human participation right now. Arbitrary message IDs, foreign
 * channels and wrong senders fail closed; redeliveries converge on the
 * retained response.
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
          sql`${addressedAgentTurns.state} in ('claimed', 'dispatching')`
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

/** Test barrier hooks for dispatch; production callers omit them. */
export type GroupTurnDispatchBarrier = Readonly<{
  /**
   * Runs after the claim converges and before the atomic dispatch
   * decision, while no row lock is held — lets parked race tests commit
   * a supersede first and prove no intent is minted.
   */
  beforeDispatchDecision?: () => Promise<void>
}>

/**
 * Thin dispatch toward real Pi-backed execution through the existing
 * lead-turn adapter (partial #1179 slice: only the currently resolved group
 * lead can dispatch today; addressed non-lead turns stay claimed and a
 * second runtime is never invented here). Claims first (durable, with full
 * human proof), then binds to current retained state and the live
 * canonical trigger inside one atomic decision, mints through the adapter
 * with a causal idempotency key (redispatch converges), and finalizes the
 * response binding — no synthetic human prompt, no duplicated content.
 */
export async function dispatchAddressedTurn(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  input: AddressedTurnClaimInput,
  options: Readonly<{
    now: string
    budget?: AddressedTurnBudget
    barrier?: GroupTurnDispatchBarrier
  }> = { now: '' }
) {
  const claim = await claimAddressedTurn(database, workspaceId, principal, input, options)
  await options.barrier?.beforeDispatchDecision?.()
  // The addressed Agent must be the currently resolved lead BEFORE
  // admission: a failed dispatch leaves the claim untouched
  // (supersede-able), never stranded mid-flight. The canonical admission
  // below re-enforces the expected Agent inside its own transaction as
  // defense in depth against a racing lead change.
  const now = options.now || new Date().toISOString()
  const leadAgentId = await resolveGroupLeadAgentId(database, workspaceId, input.channelId, now)
  if (leadAgentId !== input.agentId) throw new AddressedTurnError('turn_not_lead')
  // One serialization boundary: the admission transaction locks the claim
  // row first, verifies it is live, flips it to `dispatching`, mints (or
  // replays) the intent bound to the canonical trigger, and binds the
  // intent id — atomically. A terminal transition that commits first wins
  // with zero mint; one arriving after loses the row race with zero
  // effect. Crash recovery is redispatch (same intent, rebound). The
  // turn stays `dispatching`: the Agent's actual answer records later.
  // The admission minted no message, so there is nothing human-sent to
  // mistake for the Agent's response.
  let intent
  try {
    intent = await admitAddressedLeadTurn(database, workspaceId, input.channelId, principal, {
      claim: { id: claim.turn.id },
      expectedAgentId: input.agentId,
      triggerMessageId: input.triggerMessageId,
    })
  } catch (error) {
    // The admission reports only generic unavailability: re-read retained
    // state once, on the failure path, to keep the typed contract.
    if (error instanceof Error && error.message === 'Lead turn unavailable') {
      const [retained] = await database
        .select()
        .from(addressedAgentTurns)
        .where(
          and(
            eq(addressedAgentTurns.id, claim.turn.id),
            eq(addressedAgentTurns.workspaceId, workspaceId)
          )
        )
        .limit(1)
      if (retained?.state === 'superseded') throw new AddressedTurnError('turn_superseded')
      if (retained?.state === 'cancelled') throw new AddressedTurnError('turn_cancelled')
      if (retained?.state === 'responded') throw new AddressedTurnError('turn_already_responded')
      if (retained) {
        // Live claim, refused admission: distinguish a caller binding bug
        // (never retry) from lapsed authority (may retry).
        if (
          retained.triggerMessageId !== input.triggerMessageId ||
          retained.agentId !== input.agentId
        )
          throw new AddressedTurnError('turn_binding_mismatch')
        if (retained.addresserUserId !== principal.userId) {
          const [membership] = await database
            .select({ role: workspaceMemberships.role })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.workspaceId, workspaceId),
                eq(workspaceMemberships.userId, principal.userId)
              )
            )
            .limit(1)
          if (membership?.role !== 'owner' && membership?.role !== 'admin')
            throw new AddressedTurnError('turn_trigger_forged')
        }
        throw new AddressedTurnError('turn_not_participant')
      }
    }
    throw error
  }
  return { claim, intent }
}

/**
 * Explicit cancellation for one addressed turn (M15.02).
 * Authority: the original addresser or a workspace manager — never an
 * outsider, never another agent. Terminal states are terminal: a
 * `responded` turn already has its response, a `superseded` one is already
 * dead, and re-cancelling a `cancelled` turn converges on itself.
 *
 * Lock-ordering contract (one consistent order: channel before claims —
 * and here, no nesting at all): the claim flip commits FIRST in its own
 * transaction holding only the claim row, and only afterwards does the
 * retained-intent cancellation run in a separate transaction. The outer
 * transaction therefore never holds the claim lock while wanting the
 * channel lock, so no application-level cycle with admission (which
 * takes channel-then-claim) can form — the two serialize instead of
 * deadlocking, with no reliance on abort detection.
 *
 * When the claim bound a retained intent, cancellation is requested
 * through the EXISTING lead intent/execution boundary
 * (`requestLeadTurnCancellation`): it succeeds only when an executor
 * actually holds the intent and the canceller is its actor — otherwise the
 * outcome reports `runtimeCancelRequested: false` instead of failing the
 * claim flip or, worse, bypassing the boundary. No second runtime.
 */
export async function cancelAddressedTurn(
  database: AgentHqDatabase,
  workspaceId: string,
  principal: UserPrincipalRef,
  turnId: string
): Promise<{ state: string; runtimeCancelRequested: boolean }> {
  const flipped = await database.transaction(async (transaction) => {
    const store = asStore(transaction)
    const [turn] = await store
      .select()
      .from(addressedAgentTurns)
      .where(
        and(eq(addressedAgentTurns.id, turnId), eq(addressedAgentTurns.workspaceId, workspaceId))
      )
      .limit(1)
      .for('update')
    if (!turn) throw new AddressedTurnError('turn_claim_unresolved')
    // Authority first — even for terminal rows: an outsider guessing an
    // already-cancelled turn id gets `turn_cancel_unauthorized`, never a
    // successful cancellation response.
    const allowed =
      turn.addresserUserId === principal.userId ||
      (await isWorkspaceManager(store, workspaceId, principal.userId))
    if (!allowed) throw new AddressedTurnError('turn_cancel_unauthorized')
    if (turn.state === 'cancelled') return { already: true as const, turn }
    if (turn.state === 'responded') throw new AddressedTurnError('turn_already_responded')
    if (turn.state === 'superseded') throw new AddressedTurnError('turn_superseded')
    const updated = await store
      .update(addressedAgentTurns)
      .set({ state: 'cancelled' })
      .where(
        and(
          eq(addressedAgentTurns.id, turn.id),
          eq(addressedAgentTurns.workspaceId, workspaceId),
          sql`${addressedAgentTurns.state} in ('claimed', 'dispatching')`
        )
      )
      .returning()
    if (!updated[0]) throw new AddressedTurnError('turn_claim_unresolved')
    return { already: false as const, turn }
  })
  if (flipped.already) return { runtimeCancelRequested: false, state: 'cancelled' }
  // Separate transaction AFTER the flip commits: nothing is held while
  // the intent boundary takes its own locks (see contract above).
  const { intentId, addresserUserId } = flipped.turn
  let runtimeCancelRequested = false
  if (intentId && addresserUserId === principal.userId) {
    try {
      await requestLeadTurnCancellation(database, workspaceId, intentId, principal)
      runtimeCancelRequested = true
    } catch {
      // No executor holds this intent (never runtime-dispatched, already
      // terminal there, or otherwise unavailable): the claim flip above
      // still stands; the outcome reports it instead of failing.
      runtimeCancelRequested = false
    }
  }
  return { runtimeCancelRequested, state: 'cancelled' }
}

/**
 * Human priority: a newer human message supersedes live turns, so a
 * reconnect replays only live work in committed order. Both `claimed` and
 * `dispatching` rows flip (stale work is stale, whoever addressed it);
 * responses already recorded are history and stay untouched. For
 * `dispatching` rows with a bound intent addressed by this same principal,
 * intent cancellation is requested through the existing boundary
 * (best-effort: nothing dispatched to an executor reports back cleanly).
 * Rows addressed by others flip without reaching into their runtime
 * bindings — explicit `cancelAddressedTurn` by the addresser covers that.
 */
export async function supersedeAddressedTurns(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  channelId: string,
  principal: UserPrincipalRef
): Promise<number> {
  const store = asStore(database)
  // Canonical lock order: CHANNEL before claims — the same order the
  // human post path and the admission transaction take, so the three
  // serialize instead of deadlocking.
  const [channel] = await store
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.workspaceId, workspaceId),
        eq(channels.lifecycleState, 'active')
      )
    )
    .limit(1)
    .for('update')
  if (!channel) throw new AddressedTurnError('turn_channel_unavailable')
  const live = await store
    .select()
    .from(addressedAgentTurns)
    .where(
      and(
        eq(addressedAgentTurns.workspaceId, workspaceId),
        eq(addressedAgentTurns.channelId, channelId),
        sql`${addressedAgentTurns.state} in ('claimed', 'dispatching')`
      )
    )
  let flipped = 0
  for (const turn of live) {
    const updated = await store
      .update(addressedAgentTurns)
      .set({ state: 'superseded' })
      .where(
        and(
          eq(addressedAgentTurns.id, turn.id),
          eq(addressedAgentTurns.workspaceId, workspaceId),
          sql`${addressedAgentTurns.state} in ('claimed', 'dispatching')`
        )
      )
      .returning({ id: addressedAgentTurns.id })
    if (!updated[0]) continue
    flipped += 1
    if (turn.intentId && turn.addresserUserId === principal.userId) {
      try {
        if (isAgentHqDatabase(database))
          await requestLeadTurnCancellation(database, workspaceId, turn.intentId, principal)
      } catch {
        // Best-effort: the claim flip above stands regardless.
      }
    }
  }
  return flipped
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
