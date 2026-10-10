import { and, asc, eq, sql } from 'drizzle-orm'

import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { admissionForParticipant, loadGroupRoster } from './group-participation-store'
import { evaluateGroupGrantWindow } from './group-participation-policy'
import type { GroupAdmission } from '@adea-ai/types'
import { addressedAgentTurns, type AddressedAgentTurn } from './schema/addressed-agent-turns'

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
   * Explicit human addresser. Agent principals are rejected here, which is
   * what keeps agent chatter from ever auto-dispatching follow-up turns.
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

/**
 * Pure addressing gate. Runs before any write: the addresser must be human,
 * the Agent must hold an effective enlistment (tenant-bounded by the roster
 * loader), the revision must be positive, and recursive claims must stay
 * inside the recorded budget.
 */
export function decideAddressedTurn(
  input: AddressedTurnClaimInput,
  roster: readonly GroupAdmission[],
  parent: AddressedAgentTurn | null,
  budget: AddressedTurnBudget,
  now: string
): AddressedTurnDecision {
  if (input.addressedBy.kind !== 'user') return { action: 'deny', reason: 'turn_not_addressed' }
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

/**
 * Durable claim: persists causal ID, workspace-qualified label, revision and
 * budget before any dispatch. Concurrent duplicate claims converge on one
 * row via the (trigger, Agent, revision) unique key — the second claimer
 * reads back the winner instead of failing.
 */
export async function claimAddressedTurn(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  input: AddressedTurnClaimInput,
  options: Readonly<{ now: string; budget?: AddressedTurnBudget }> = { now: '' }
): Promise<AddressedTurnClaim> {
  const store = asStore(database)
  const budget = options.budget ?? input.budget ?? DEFAULT_ADDRESSED_TURN_BUDGET
  const roster = await loadGroupRoster(store, workspaceId, input.channelId)
  const parent = input.parentTurnId
    ? ((
        await store
          .select()
          .from(addressedAgentTurns)
          .where(
            and(
              eq(addressedAgentTurns.id, input.parentTurnId),
              eq(addressedAgentTurns.workspaceId, workspaceId)
            )
          )
          .limit(1)
      )?.[0] ?? null)
    : null
  const decision = decideAddressedTurn(input, roster, parent, budget, options.now)
  if (decision.action === 'deny') throw new AddressedTurnError(decision.reason)
  const existing = await countTriggerTree(store, input.triggerMessageId)
  if (existing >= budget.maxTurns) throw new AddressedTurnError('turn_budget_exhausted')
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
  const winner = await store
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
  const turn = winner[0]
  if (!turn) throw new AddressedTurnError('turn_claim_unresolved')
  return { status: 'duplicate', turn }
}

/**
 * Records the single response for a claimed turn. The conditional update
 * makes redelivered responses converge: only the first write wins, later
 * ones report the already-responded row.
 */
export async function recordAddressedTurnResponse(
  database: AgentHqDatabase | AgentHqTransaction,
  workspaceId: string,
  turnId: string,
  responseMessageId: string
): Promise<AddressedAgentTurn> {
  const store = asStore(database)
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
  const current = await store
    .select()
    .from(addressedAgentTurns)
    .where(
      and(eq(addressedAgentTurns.id, turnId), eq(addressedAgentTurns.workspaceId, workspaceId))
    )
    .limit(1)
  const turn = current[0]
  if (!turn) throw new AddressedTurnError('turn_response_unresolved')
  return turn
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
