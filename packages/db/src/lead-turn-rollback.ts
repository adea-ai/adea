import type { UserPrincipalRef } from '@adea-ai/types'
import { and, eq, isNull } from 'drizzle-orm'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { withHistoricalLeadTurn } from './lead-turns'
import { channels } from './schema/conversations'
import { leadTurnIntents } from './schema/lead-turns'
import { leadTurnRuntime } from './schema/lead-turn-runtime'
import { workspaceMemberships } from './schema/workspaces'

// Rollback readers and uncertain-effect fencing for lead turns (M18.01.3, #1220).
//
// The fence is an admission-level flag. It is set once, before a rollback routes new work away
// from the Pi path, and it stops this path from preparing or dispatching the same admission again.
// Observation, binding recovery, cancellation and publication of an already-recorded result stay
// available, because they reconcile evidence rather than create a new effect. Fencing never
// rewrites state, dispatch identity, runtime session or publication evidence.
//
// Attribution (REQ 154): the fence records who applied it, why, when, and the authority it relied
// on. All of it is written in the same statement as the fence, and a database CHECK rejects a
// partial fence. Readers get the attribution with the evidence.
//
// Fail closed: a non-terminal admission that is not fenced is `fence_required`, and an observed row
// that does not match a known evidence shape is `blocked_unclassifiable`. Neither is ever read as
// safe to resume or reroute.

export type LeadTurnRollbackDisposition =
  /** Not fenced yet and not terminal: the fence must be applied before any routing decision. */
  | 'fence_required'
  /** Fenced, and no dispatch was requested: the admission is not yet owned by any runtime. */
  | 'no_effect_recorded'
  /** Fenced, and a dispatch may exist without an observed outcome. Reconcile before any resume. */
  | 'reconcile_uncertain_effect'
  /** Fenced, and a runtime session was observed as active. The owner is the runtime, not a reroute. */
  | 'in_flight_fenced'
  /** Terminal outcome retained as history. Nothing resumes from it. */
  | 'terminal_retained'
  /** Evidence does not match a known shape. Preserved as-is and never resumed. */
  | 'blocked_unclassifiable'

const dispositions: readonly LeadTurnRollbackDisposition[] = [
  'fence_required',
  'no_effect_recorded',
  'reconcile_uncertain_effect',
  'in_flight_fenced',
  'terminal_retained',
  'blocked_unclassifiable',
]

export type LeadTurnRollbackEvidence = Readonly<{
  fenced: boolean
  runtime?: Readonly<{
    state: string
    dispatchId: string | null
    runtimeSessionId: string | null
    observedAt: Date | null
  }>
}>

const terminalStates = ['cancelled', 'completed', 'failed', 'timed_out']
const inFlightStates = ['awaiting_input', 'cancelling', 'running', 'starting']
const uncertainStates = ['dispatch_pending', 'unknown']

/** Pure classification of retained evidence. Performs no I/O and never changes evidence. */
export function classifyLeadTurnRollback(
  evidence: LeadTurnRollbackEvidence
): LeadTurnRollbackDisposition {
  const runtime = evidence.runtime
  if (!runtime) return evidence.fenced ? 'no_effect_recorded' : 'fence_required'
  if (terminalStates.includes(runtime.state)) return 'terminal_retained'
  if (!evidence.fenced) return 'fence_required'
  if (runtime.state === 'prepared') {
    return runtime.dispatchId === null && runtime.runtimeSessionId === null
      ? 'no_effect_recorded'
      : 'blocked_unclassifiable'
  }
  if (uncertainStates.includes(runtime.state)) return 'reconcile_uncertain_effect'
  if (inFlightStates.includes(runtime.state)) {
    return runtime.dispatchId !== null &&
      runtime.runtimeSessionId !== null &&
      runtime.observedAt !== null
      ? 'in_flight_fenced'
      : 'blocked_unclassifiable'
  }
  return 'blocked_unclassifiable'
}

/**
 * Serializes new effects against the rollback fence. Callers that prepare or dispatch lock the
 * intent before the runtime row, the same order the fence uses, so a concurrent fence is either
 * fully visible to the check or waits for the dispatch to finish.
 */
export async function assertLeadTurnNotFenced(
  tx: AgentHqTransaction,
  intentId: string,
  mode: 'share' | 'update' = 'update'
) {
  const [intent] = await tx
    .select({ rollbackFencedAt: leadTurnIntents.rollbackFencedAt })
    .from(leadTurnIntents)
    .where(eq(leadTurnIntents.id, intentId))
    .for(mode)
  if (!intent || intent.rollbackFencedAt) throw new Error('LEAD_TURN_FENCED')
}

export const leadTurnRollbackFenceReasons = ['operator_intervention', 'rollback_cohort'] as const
export type LeadTurnRollbackFenceReason = (typeof leadTurnRollbackFenceReasons)[number]

/**
 * `user` is a workspace owner or admin acting through a server surface. `operator` is a trusted
 * in-process operations caller that has no workspace membership. Both are attributed by reference.
 */
export type LeadTurnRollbackFenceActor =
  | Readonly<{ kind: 'user'; principal: UserPrincipalRef }>
  | Readonly<{ kind: 'operator'; operatorId: string }>

export type LeadTurnRollbackFenceRequest = Readonly<{
  actor: LeadTurnRollbackFenceActor
  reason: LeadTurnRollbackFenceReason
}>

/** Retained authority the fence relied on, captured in the same transaction as the fence. */
export type LeadTurnRollbackFenceAuthority = Readonly<{
  schemaVersion: 1
  workspaceId: string
  actorMembershipId: string | null
  actorRole: 'owner' | 'admin' | null
  channelId: string
  channelVersion: number
  channelLifecycleState: 'active' | 'archived'
  runtimeState: string | null
  disposition: LeadTurnRollbackDisposition
}>

export type LeadTurnRollbackAttribution = Readonly<{
  fencedAt: string
  actor: Readonly<{ kind: 'user'; userId: string } | { kind: 'operator'; operatorId: string }>
  reason: LeadTurnRollbackFenceReason
  authority: LeadTurnRollbackFenceAuthority
}>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const operatorIdPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/

/** Rejects a malformed request before any database work, so no partial attribution can exist. */
export function assertLeadTurnRollbackFenceRequest(request: LeadTurnRollbackFenceRequest) {
  if (!(leadTurnRollbackFenceReasons as readonly string[]).includes(request.reason))
    throw new Error('INVALID_ROLLBACK_FENCE_REQUEST')
  if (request.actor.kind === 'user') {
    if (!uuidPattern.test(request.actor.principal.userId))
      throw new Error('INVALID_ROLLBACK_FENCE_REQUEST')
    return
  }
  if (request.actor.kind !== 'operator' || !operatorIdPattern.test(request.actor.operatorId))
    throw new Error('INVALID_ROLLBACK_FENCE_REQUEST')
}

/** Fail-closed parse of retained authority. Unknown or malformed evidence is never trusted. */
export function parseLeadTurnRollbackAuthority(value: unknown): LeadTurnRollbackFenceAuthority {
  const record = value as Record<string, unknown> | null
  if (
    typeof record !== 'object' ||
    record === null ||
    record.schemaVersion !== 1 ||
    typeof record.workspaceId !== 'string' ||
    !(record.actorMembershipId === null || typeof record.actorMembershipId === 'string') ||
    !(record.actorRole === null || record.actorRole === 'owner' || record.actorRole === 'admin') ||
    typeof record.channelId !== 'string' ||
    !Number.isSafeInteger(record.channelVersion) ||
    (record.channelVersion as number) < 1 ||
    (record.channelLifecycleState !== 'active' && record.channelLifecycleState !== 'archived') ||
    !(record.runtimeState === null || typeof record.runtimeState === 'string') ||
    !dispositions.includes(record.disposition as LeadTurnRollbackDisposition)
  )
    throw new Error('LEAD_TURN_FENCE_EVIDENCE_INVALID')
  return record as unknown as LeadTurnRollbackFenceAuthority
}

export type LeadTurnFenceRow = Readonly<{
  rollbackFencedAt: Date | null
  rollbackFenceActorKind: string | null
  rollbackFenceActorRef: string | null
  rollbackFenceReason: string | null
  rollbackFenceAuthority: unknown
}>

function attributionOf(row: LeadTurnFenceRow): LeadTurnRollbackAttribution | undefined {
  if (!row.rollbackFencedAt) return undefined
  const { rollbackFenceActorKind: kind, rollbackFenceActorRef: ref } = row
  const reason = row.rollbackFenceReason
  if (
    !ref ||
    !(kind === 'user' || kind === 'operator') ||
    !(leadTurnRollbackFenceReasons as readonly string[]).includes(reason ?? '')
  )
    throw new Error('LEAD_TURN_FENCE_EVIDENCE_INVALID')
  return {
    fencedAt: row.rollbackFencedAt.toISOString(),
    actor: kind === 'user' ? { kind, userId: ref } : { kind, operatorId: ref },
    reason: reason as LeadTurnRollbackFenceReason,
    authority: parseLeadTurnRollbackAuthority(row.rollbackFenceAuthority),
  }
}

/**
 * Fence facts emitted by the signed product reader to CP. Null when the admission is not fenced.
 * Retained authority (membership and channel detail) stays inside Adea and is not emitted.
 */
export type LeadTurnRollbackFenceEmission = Readonly<{
  fencedAt: string
  reason: LeadTurnRollbackFenceReason
  actor: Readonly<{ kind: 'user'; userId: string } | { kind: 'operator'; operatorId: string }>
}>

export function rollbackFenceEmission(row: LeadTurnFenceRow): LeadTurnRollbackFenceEmission | null {
  const attribution = attributionOf(row)
  if (!attribution) return null
  return {
    fencedAt: attribution.fencedAt,
    reason: attribution.reason,
    actor: attribution.actor,
  }
}

async function resolveFenceActor(
  tx: AgentHqTransaction,
  workspaceId: string,
  actor: LeadTurnRollbackFenceActor
): Promise<Readonly<{ membershipId: string | null; role: 'owner' | 'admin' | null }>> {
  if (actor.kind === 'operator') return { membershipId: null, role: null }
  const [member] = await tx
    .select({ id: workspaceMemberships.id, role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, actor.principal.userId)
      )
    )
    .for('share')
  if (!member) throw new Error('Lead turn unavailable')
  if (member.role !== 'owner' && member.role !== 'admin')
    throw new Error('ROLLBACK_FENCE_FORBIDDEN')
  return { membershipId: member.id, role: member.role }
}

export type LeadTurnRollbackFence = Readonly<{
  intentId: string
  disposition: LeadTurnRollbackDisposition
  fenced: boolean
  /** True when an earlier fence already held. The original attribution is returned, not replaced. */
  alreadyFenced: boolean
  attribution?: LeadTurnRollbackAttribution
}>

/**
 * Trusted rollback boundary, called by server rollback tooling and never by a user principal.
 * A user actor must currently be a workspace owner or admin, checked under lock in the same
 * transaction as the write. The first fence keeps its attribution; later calls return it unchanged.
 * Terminal admissions are not written.
 */
export async function fenceLeadTurnForRollback(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  request: LeadTurnRollbackFenceRequest
): Promise<LeadTurnRollbackFence> {
  assertLeadTurnRollbackFenceRequest(request)
  return database.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(leadTurnIntents)
      .where(and(eq(leadTurnIntents.id, intentId), eq(leadTurnIntents.workspaceId, workspaceId)))
      .for('update')
    if (!intent) throw new Error('Lead turn unavailable')
    const actor = await resolveFenceActor(tx, workspaceId, request.actor)
    const [channel] = await tx
      .select({
        id: channels.id,
        version: channels.version,
        lifecycleState: channels.lifecycleState,
      })
      .from(channels)
      .where(and(eq(channels.id, intent.channelId), eq(channels.workspaceId, workspaceId)))
      .for('share')
    if (!channel) throw new Error('Lead turn unavailable')
    const [row] = await tx
      .select()
      .from(leadTurnRuntime)
      .where(eq(leadTurnRuntime.intentId, intentId))
      .for('update')
    if (intent.rollbackFencedAt) {
      return {
        intentId,
        disposition: classifyLeadTurnRollback({ fenced: true, runtime: row }),
        fenced: true,
        alreadyFenced: true,
        attribution: attributionOf(intent),
      }
    }
    if (row && terminalStates.includes(row.state)) {
      return {
        intentId,
        disposition: classifyLeadTurnRollback({ fenced: false, runtime: row }),
        fenced: false,
        alreadyFenced: false,
      }
    }
    const disposition = classifyLeadTurnRollback({ fenced: true, runtime: row })
    const authority: LeadTurnRollbackFenceAuthority = {
      schemaVersion: 1,
      workspaceId,
      actorMembershipId: actor.membershipId,
      actorRole: actor.role,
      channelId: channel.id,
      channelVersion: channel.version,
      channelLifecycleState: channel.lifecycleState,
      runtimeState: row?.state ?? null,
      disposition,
    }
    const [updated] = await tx
      .update(leadTurnIntents)
      .set({
        rollbackFencedAt: new Date(),
        rollbackFenceActorKind: request.actor.kind,
        rollbackFenceActorRef:
          request.actor.kind === 'user' ? request.actor.principal.userId : request.actor.operatorId,
        rollbackFenceReason: request.reason,
        rollbackFenceAuthority: authority,
      })
      .where(and(eq(leadTurnIntents.id, intentId), isNull(leadTurnIntents.rollbackFencedAt)))
      .returning()
    if (!updated) throw new Error('Lead turn unavailable')
    return {
      intentId,
      disposition,
      fenced: true,
      alreadyFenced: false,
      attribution: attributionOf(updated),
    }
  })
}

export type LeadTurnRollbackState = Readonly<{
  intentId: string
  messageId: string
  channelLifecycleState: 'active' | 'archived'
  disposition: LeadTurnRollbackDisposition
  fenced: boolean
  attribution?: LeadTurnRollbackAttribution
  runtime?: Readonly<{
    state: string
    executionId: string
    attemptId: string
    dispatchId?: string
    runtimeSessionId?: string
    observedAt?: string
    publishedMessageId?: string
  }>
}>

/**
 * Rollback reader for a current participant. It uses the canonical historical boundary shared with
 * getLeadTurnForUser and readLeadTurnRuntime, so authorized archived history stays observable and
 * no effect is granted. A denied user gets the same unavailable answer and learns nothing about
 * the fence.
 */
export function readLeadTurnRollbackState(
  database: AgentHqDatabase,
  workspaceId: string,
  intentId: string,
  principal: UserPrincipalRef
): Promise<LeadTurnRollbackState> {
  return withHistoricalLeadTurn(
    database,
    workspaceId,
    intentId,
    principal,
    'read',
    async (tx, intent, _message, _controlPlaneWorkspaceId, channel) => {
      const [row] = await tx
        .select()
        .from(leadTurnRuntime)
        .where(eq(leadTurnRuntime.intentId, intent.id))
      const fenced = intent.rollbackFencedAt !== null
      const attribution = attributionOf(intent)
      const runtime = row
        ? {
            state: row.state,
            executionId: row.executionId,
            attemptId: row.attemptId,
            ...(row.dispatchId ? { dispatchId: row.dispatchId } : {}),
            ...(row.runtimeSessionId ? { runtimeSessionId: row.runtimeSessionId } : {}),
            ...(row.observedAt ? { observedAt: row.observedAt.toISOString() } : {}),
            ...(row.publishedMessageId ? { publishedMessageId: row.publishedMessageId } : {}),
          }
        : undefined
      return {
        intentId: intent.id,
        messageId: intent.messageId,
        channelLifecycleState: channel.lifecycleState,
        disposition: classifyLeadTurnRollback({ fenced, runtime: row }),
        fenced,
        ...(attribution ? { attribution } : {}),
        ...(runtime ? { runtime } : {}),
      }
    }
  )
}
