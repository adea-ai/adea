/*
 * Group audience and participation policy (M15 #1178).
 *
 * Pure validation and authorization over the `group-participation` types.
 * Like `task-execution.ts`, this module imports only types from
 * `@adea-ai/types` so the database layer never needs its build output. It
 * performs no I/O: atomic group creation, live enlistment and publication
 * are later integration slices (adea#1179, adea#1180).
 *
 * Semantics:
 * - Creation is all-or-nothing; every invalid participant is enumerated with
 *   a typed reason and no partial roster is produced, and each admission
 *   retains the binding to the exact authorizing group, grant and revision.
 * - Admission validates every grant's identity up front: a blank grant id or
 *   a malformed, non-positive or wrong-typed revision fails closed with a
 *   typed reason, and a grant only ever admits into the group it was issued
 *   for. The retained authorization binding is sourced from the grant's own
 *   group identity, never relabelled from the request's label.
 * - Every decision path re-runs that same shared identity validation on each
 *   grant it consumes: history reads, summary reads, turns and publication
 *   all require the retained binding — and, for reads, every sharing grant —
 *   to carry a nonblank id, a positive safe-integer revision (zero is a
 *   revision nowhere) and the group of the decision itself. An unprovable
 *   grant fails closed with the admission-style typed reasons
 *   (`grant_id_missing`, `grant_revision_invalid`, `grant_mismatched_group`)
 *   and authorizes nothing on any path.
 * - Participants must belong to the group's owning workspace; workspace
 *   membership alone grants nothing — enlistment and audience membership
 *   require explicit grants, and private history requires explicit
 *   audience-aware sharing.
 * - Every revocation timestamp is evaluated fail closed: an unparseable
 *   `revokedAt` behaves as revoked, never as absent.
 * - Agents are identified by a stable workspace-qualified identity, never by
 *   display name, and a grant never transfers: publication stays bound to
 *   the participant the job's authority was issued to.
 * - Revocation denies future reads and turns immediately and holds a revoked
 *   participant's late results out of the group. Late publication also
 *   compares the job's retained authorization binding with the participant's
 *   current one, so a job admitted under a revoked grant stays blocked even
 *   when an identical-looking replacement grant now exists. A hold is a gate:
 *   the independently owned job is never cancelled or reassigned here.
 */
import type {
  ConversationParticipantRef,
  GroupAdmission,
  GroupAuthorizationBinding,
  GroupCreationInput,
  GroupCreationRejection,
  GroupCreationRejectionReason,
  GroupCreationValidation,
  GroupGrantState,
  GroupGrantIdentityRejectionReason,
  GroupGrantWindow,
  GroupHistoryReadDecision,
  GroupHistoryReadInput,
  GroupPublicationDecision,
  GroupPublicationInput,
  GroupSharingGrant,
  GroupSharingScope,
  GroupSummaryReadDecision,
  GroupSummaryReadInput,
  GroupTurnDecision,
  GroupTurnInput,
  QualifiedAgentIdentity,
} from '@adea-ai/types'

/** A newly created group has no earlier history, so every founder joins at sequence 0. */
export const GROUP_CREATION_JOIN_SEQUENCE = 0

/** Rejection reasons attributable to one creation candidate. */
type CandidateRejectionReason = Exclude<
  GroupCreationRejectionReason,
  'audience_empty' | 'audience_requires_human' | 'group_workspace_missing'
>

/**
 * The stable key form of a qualified Agent identity. It is a composition of
 * the existing workspace and Agent ID types; a display name never enters it.
 */
export function workspaceQualifiedAgentKey(identity: QualifiedAgentIdentity): string {
  return `${identity.workspaceId}:${identity.agentId}`
}

export function sameQualifiedAgentIdentity(
  left: QualifiedAgentIdentity,
  right: QualifiedAgentIdentity
): boolean {
  return left.agentId === right.agentId && left.workspaceId === right.workspaceId
}

function sameParticipant(
  left: ConversationParticipantRef,
  right: ConversationParticipantRef
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'user' && right.kind === 'user') return left.userId === right.userId
  if (left.kind === 'agent' && right.kind === 'agent') return left.agentId === right.agentId
  return false
}

/**
 * A retained binding is usable only when it passes the one shared
 * grant-identity validation: a nonblank grant id and group, and a positive
 * safe-integer revision — the exact rule admission enforces, so zero, a
 * negative, a malformed or a wrong-typed revision is valid nowhere.
 */
function wellFormedBinding(binding: GroupAuthorizationBinding): boolean {
  return grantIdentityRejection(binding, binding.groupId) === null
}

/**
 * Whether a retained authorization binding still names the current one. A
 * malformed binding on either side never matches: a job that cannot prove
 * which grant authorized it is never published.
 */
function sameAuthorizationBinding(
  retained: GroupAuthorizationBinding,
  current: GroupAuthorizationBinding
): boolean {
  return (
    wellFormedBinding(retained) &&
    wellFormedBinding(current) &&
    retained.groupId === current.groupId &&
    retained.grantId === current.grantId &&
    retained.revision === current.revision
  )
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function hasText(value: string): boolean {
  return value.trim().length > 0
}

/**
 * Whether a grant window is in force at `now`, with a typed diagnosis. Every
 * non-effective state — expired, stale, not yet issued or revoked — behaves
 * as absent. Unreadable timestamps fail closed: a malformed `revokedAt`
 * behaves as revoked (the grant cannot be proven unrevoked), and any other
 * unreadable field behaves as expired.
 */
export function evaluateGroupGrantWindow(window: GroupGrantWindow, now: string): GroupGrantState {
  const nowMs = parseTimestamp(now)
  if (nowMs === null) return 'expired'
  if (window.revokedAt !== null) {
    const revokedAtMs = parseTimestamp(window.revokedAt)
    if (revokedAtMs === null || revokedAtMs <= nowMs) return 'revoked'
  }
  const issuedAtMs = parseTimestamp(window.issuedAt)
  if (issuedAtMs === null) return 'expired'
  if (issuedAtMs > nowMs) return 'not_yet_issued'
  if (window.expiresAt !== null) {
    const expiresAtMs = parseTimestamp(window.expiresAt)
    if (expiresAtMs === null || nowMs >= expiresAtMs) return 'expired'
  }
  return 'effective'
}

function rejectionForGrantState(state: Exclude<GroupGrantState, 'effective'>) {
  switch (state) {
    case 'expired':
      return 'grant_expired'
    case 'not_yet_issued':
      return 'grant_not_yet_issued'
    case 'revoked':
      return 'grant_revoked'
  }
}

function grantWindow(grant: GroupGrantWindow): GroupGrantWindow {
  return { expiresAt: grant.expiresAt, issuedAt: grant.issuedAt, revokedAt: grant.revokedAt }
}

/**
 * The one grant-identity validation every grant-consuming path shares,
 * admission included: the grant id must be present, the revision a positive
 * safe integer (a malformed, non-positive or wrong-typed revision proves
 * nothing — zero is a revision nowhere), and the grant must carry the group
 * of the decision context — a grant with a blank or different group never
 * matches and is never relabelled into it. Returns the typed rejection, or
 * null when the grant's identity is provable.
 */
function grantIdentityRejection(
  grant: Readonly<{ grantId: string; groupId: string; revision: number }>,
  contextGroupId: string
): GroupGrantIdentityRejectionReason | null {
  if (!hasText(grant.grantId)) return 'grant_id_missing'
  if (!Number.isSafeInteger(grant.revision) || grant.revision < 1) return 'grant_revision_invalid'
  if (!hasText(grant.groupId) || grant.groupId !== contextGroupId) return 'grant_mismatched_group'
  return null
}

function joinPointAt(now: string) {
  return { joinedAt: now, joinedSequence: GROUP_CREATION_JOIN_SEQUENCE }
}

/**
 * Validates a whole group creation against its owning group id, workspace and
 * the candidates' explicit grants. All-or-nothing: any rejection fails the
 * whole creation and enumerates every invalid participant; only a fully valid
 * roster is admitted, each member at the creation join point with the
 * authorization retained from their grant's own identity — its group, grant
 * id and revision — never relabelled from the request. A grant admits only
 * with a nonblank id, a positive revision and its own issuing group.
 * At least one human candidate is required as the founding audience.
 */
export function validateGroupCreation(input: GroupCreationInput): GroupCreationValidation {
  if (!hasText(input.workspaceId))
    return { ok: false, rejections: [{ reason: 'group_workspace_missing', scope: 'group' }] }
  if (!hasText(input.groupId))
    return { ok: false, rejections: [{ reason: 'group_id_missing', scope: 'group' }] }
  if (input.candidates.length === 0)
    return { ok: false, rejections: [{ reason: 'audience_empty', scope: 'group' }] }

  const rejections: GroupCreationRejection[] = []
  const roster: GroupAdmission[] = []
  const seenParticipants = new Set<string>()
  let humanCandidates = 0

  input.candidates.forEach((candidate, candidateIndex) => {
    const reject = (participant: ConversationParticipantRef, reason: CandidateRejectionReason) => {
      rejections.push({ candidateIndex, participant, reason, scope: 'candidate' })
    }

    if (candidate.kind === 'human') {
      humanCandidates += 1
      const { audienceGrant, participant, workspaceId } = candidate
      if (!hasText(participant.userId)) return reject(participant, 'participant_unqualified')
      if (workspaceId !== input.workspaceId) return reject(participant, 'participant_cross_tenant')
      if (!audienceGrant) return reject(participant, 'grant_absent')
      if (audienceGrant.participant.userId !== participant.userId)
        return reject(participant, 'grant_mismatched_participant')
      const identityRejection = grantIdentityRejection(audienceGrant, input.groupId)
      if (identityRejection) return reject(participant, identityRejection)
      const state = evaluateGroupGrantWindow(audienceGrant, input.now)
      if (state !== 'effective') return reject(participant, rejectionForGrantState(state))
      if (seenParticipants.has(`user:${participant.userId}`))
        return reject(participant, 'duplicate_participant')
      seenParticipants.add(`user:${participant.userId}`)
      roster.push({
        authorization: {
          groupId: audienceGrant.groupId,
          grantId: audienceGrant.grantId,
          revision: audienceGrant.revision,
        },
        grant: grantWindow(audienceGrant),
        joinPoint: joinPointAt(input.now),
        participant,
      })
      return
    }

    const { agentId, enlistmentGrant, workspaceId } = candidate
    const participant = { agentId, kind: 'agent' } as const
    if (!hasText(agentId) || !hasText(workspaceId))
      return reject(participant, 'participant_unqualified')
    // Enlisted Agents keep their source workspace: the host workspace never
    // confers authority over them. The claimed source must be nonblank and
    // match the grant's own qualified identity here; the transactional layer
    // then proves it against the Agent registry (true home workspace and
    // active standing) before anything persists — a spoofed source fails
    // there with `grant_workspace_mismatch`, never here by equality.
    if (!enlistmentGrant) return reject(participant, 'grant_absent')
    if (!sameQualifiedAgentIdentity(enlistmentGrant.agent, candidate))
      return reject(participant, 'grant_mismatched_participant')
    const identityRejection = grantIdentityRejection(enlistmentGrant, input.groupId)
    if (identityRejection) return reject(participant, identityRejection)
    const state = evaluateGroupGrantWindow(enlistmentGrant, input.now)
    if (state !== 'effective') return reject(participant, rejectionForGrantState(state))
    const key = `agent:${workspaceQualifiedAgentKey(candidate)}`
    if (seenParticipants.has(key)) return reject(participant, 'duplicate_participant')
    seenParticipants.add(key)
    roster.push({
      authorization: {
        groupId: enlistmentGrant.groupId,
        grantId: enlistmentGrant.grantId,
        revision: enlistmentGrant.revision,
      },
      grant: grantWindow(enlistmentGrant),
      joinPoint: joinPointAt(input.now),
      participant,
    })
  })

  if (humanCandidates === 0) rejections.push({ reason: 'audience_requires_human', scope: 'group' })
  if (rejections.length > 0) return { ok: false, rejections }
  return { ok: true, roster }
}

function sharingGrantEffective(
  input: Readonly<{
    admissionParticipant: ConversationParticipantRef
    contextGroupId: string
    now: string
    scope: GroupSharingScope
    sharingGrants: readonly GroupSharingGrant[]
  }>
): boolean {
  return input.sharingGrants.some(
    (grant) =>
      grant.scope === input.scope &&
      sameParticipant(grant.participant, input.admissionParticipant) &&
      // The sharing grant passes the same shared identity validation as every
      // other grant: an empty id, an invalid revision or a grant issued for
      // another group authorizes nothing here and behaves as absent.
      grantIdentityRejection(grant, input.contextGroupId) === null &&
      evaluateGroupGrantWindow(grant, input.now) === 'effective'
  )
}

/**
 * Join-point history policy: a participant admitted at their join point sees
 * sequences from it onward by default; earlier history requires an explicit
 * `earlier_history` sharing grant scoped to them. Every grant consumed here
 * passes the shared identity validation first: the admission's retained
 * binding must prove which grant and group admit the reader — bound to the
 * group being read — and every sharing grant must be bound to that same
 * group, so an unprovable or foreign grant fails closed and authorizes
 * nothing.
 */
export function decideGroupHistoryRead(input: GroupHistoryReadInput): GroupHistoryReadDecision {
  const admission = input.admission
  if (!admission) return { action: 'deny', reason: 'history_not_participant' }
  const state = evaluateGroupGrantWindow(admission.grant, input.now)
  const identityRejection = grantIdentityRejection(admission.authorization, input.groupId)
  if (identityRejection)
    // An unprovable grant behaves as absent with its typed admission-style
    // reason, exactly as admission would have rejected it.
    return { action: 'deny', participationState: state, reason: identityRejection }
  if (state === 'revoked')
    return { action: 'deny', participationState: state, reason: 'history_participation_revoked' }
  if (state !== 'effective')
    // A stale grant behaves as absent: not a participant, never an implicit one.
    return { action: 'deny', participationState: state, reason: 'history_not_participant' }
  if (input.entry.sequence >= admission.joinPoint.joinedSequence)
    return { action: 'allow', basis: 'within_join_point', participationState: state }
  if (
    sharingGrantEffective({
      admissionParticipant: admission.participant,
      contextGroupId: input.groupId,
      now: input.now,
      scope: 'earlier_history',
      sharingGrants: input.sharingGrants,
    })
  )
    return { action: 'allow', basis: 'earlier_history_grant', participationState: state }
  return { action: 'deny', participationState: state, reason: 'history_before_join_point' }
}

/**
 * Authorized summaries: a summary reaching before the join point requires an
 * explicit `earlier_summary` sharing grant scoped to the reader; an
 * `earlier_history` grant never unlocks it and vice versa. Every grant
 * consumed here passes the shared identity validation first: the retained
 * binding must prove which grant and group admit the reader — bound to the
 * group whose summary is read — and every sharing grant must be bound to
 * that same group, so an unprovable or foreign grant fails closed and
 * authorizes nothing.
 */
export function decideGroupSummaryRead(input: GroupSummaryReadInput): GroupSummaryReadDecision {
  const admission = input.admission
  if (!admission) return { action: 'deny', reason: 'summary_not_participant' }
  const state = evaluateGroupGrantWindow(admission.grant, input.now)
  const identityRejection = grantIdentityRejection(admission.authorization, input.groupId)
  if (identityRejection)
    return { action: 'deny', participationState: state, reason: identityRejection }
  if (state === 'revoked')
    return { action: 'deny', participationState: state, reason: 'summary_participation_revoked' }
  if (state !== 'effective')
    return { action: 'deny', participationState: state, reason: 'summary_not_participant' }
  if (input.fromSequence >= admission.joinPoint.joinedSequence)
    return { action: 'allow', basis: 'within_join_point', participationState: state }
  if (
    sharingGrantEffective({
      admissionParticipant: admission.participant,
      contextGroupId: input.groupId,
      now: input.now,
      scope: 'earlier_summary',
      sharingGrants: input.sharingGrants,
    })
  )
    return { action: 'allow', basis: 'earlier_summary_grant', participationState: state }
  return { action: 'deny', participationState: state, reason: 'summary_before_join_point' }
}

/**
 * Turns require an effective participation grant at `now`; revocation denies
 * the next turn immediately and an expired grant behaves as absent. The
 * retained binding must first prove which grant and group admit the
 * participant — bound to the group the turn is taken in — so an unprovable
 * or foreign grant fails closed and takes no turn.
 */
export function decideGroupTurn(input: GroupTurnInput): GroupTurnDecision {
  const admission = input.admission
  if (!admission) return { action: 'deny', reason: 'turn_not_participant' }
  const state = evaluateGroupGrantWindow(admission.grant, input.now)
  const identityRejection = grantIdentityRejection(admission.authorization, input.groupId)
  if (identityRejection)
    return { action: 'deny', participationState: state, reason: identityRejection }
  if (state === 'revoked')
    return { action: 'deny', participationState: state, reason: 'turn_participation_revoked' }
  if (state !== 'effective')
    return { action: 'deny', participationState: state, reason: 'turn_not_participant' }
  return { action: 'allow' }
}

/**
 * The publication gate for a completed job. The publisher must be the
 * participant the job's authority was bound to, the job's retained
 * authorization binding must still name the participant's current group,
 * grant and revision — so a job admitted under a revoked or superseded grant
 * stays held even when an identical-looking replacement grant exists — and
 * the participant must have been effective at completion and still be
 * effective now. Both bindings must be well-formed under the one shared
 * identity validation, so a zero, negative or wrong-typed revision — or a
 * blank id — is valid here exactly as nowhere else. Holding never cancels
 * the job and never transfers its authority.
 */
export function decideGroupPublication(input: GroupPublicationInput): GroupPublicationDecision {
  const { job } = input
  if (
    !sameParticipant(input.publisher, job.participant) ||
    (input.admission !== null && !sameParticipant(input.admission.participant, input.publisher))
  )
    return { action: 'hold', jobId: job.jobId, reason: 'publication_authority_mismatch' }
  if (!input.admission)
    return { action: 'hold', jobId: job.jobId, reason: 'publication_unauthorized_at_completion' }
  if (
    job.authorization === null ||
    !sameAuthorizationBinding(job.authorization, input.admission.authorization)
  )
    return { action: 'hold', jobId: job.jobId, reason: 'publication_binding_mismatch' }
  const nowState = evaluateGroupGrantWindow(input.admission.grant, input.now)
  if (nowState === 'revoked')
    return { action: 'hold', jobId: job.jobId, reason: 'publication_participation_revoked' }
  if (nowState !== 'effective')
    return { action: 'hold', jobId: job.jobId, reason: 'publication_participation_stale' }
  const completedState = evaluateGroupGrantWindow(input.admission.grant, job.completedAt)
  if (completedState !== 'effective')
    return { action: 'hold', jobId: job.jobId, reason: 'publication_unauthorized_at_completion' }
  return { action: 'publish', basis: 'participant_authorized', jobId: job.jobId }
}
