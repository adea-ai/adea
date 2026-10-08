/**
 * Group audience and participation types for M15 #1178.
 *
 * This module holds the identity, grant, decision and typed-rejection shapes
 * for tenant-bounded groups: explicit human audience grants, explicit Agent
 * enlistment grants, join-point history policy and revocation. Grants carry an
 * identity and revision and are bound to the group they were issued for;
 * admissions and completed jobs retain the binding to the exact authorizing
 * group/grant/revision, and every revocation timestamp
 * is evaluated fail closed. It is consumed by the pure policy functions in
 * `@adea-ai/db`'s `group-participation-policy` module and deliberately
 * contains no I/O: atomic group creation, live enlistment and publication are
 * later integration slices.
 */
import type { ConversationParticipantRef, UserPrincipalRef } from './index'

export type GroupParticipantRef = ConversationParticipantRef

/**
 * The stable identity of an Agent inside one owning workspace: a composition
 * of the existing workspace ID and Agent ID types. Two Agents may share a
 * display name; this identity never does, and no grant or authority is ever
 * resolved by display name.
 */
export type QualifiedAgentIdentity = Readonly<{ agentId: string; workspaceId: string }>

/**
 * The lifetime every group grant shares. `issuedAt`/`expiresAt` are the
 * grant's validity window (an expired or not-yet-issued grant behaves as
 * absent) and `revokedAt` ends it immediately; an unparseable `revokedAt`
 * fails closed and behaves as revoked.
 */
export type GroupGrantWindow = Readonly<{
  expiresAt: string | null
  issuedAt: string
  revokedAt: string | null
}>

/**
 * The stable identity of a grant: its `grantId` plus an issuance `revision`
 * that increments on every re-issuance of the same grant. Authorizations
 * retain both so a replacement or stale revision can never pass for the
 * grant that actually authorized a participant or a job.
 */
export type GroupGrantIdentity = Readonly<{ grantId: string; revision: number }>

/**
 * The authorization an admission or a completed job retains: which group's
 * grant, by identity and revision, authorized it. Late publication compares
 * the job's retained binding against the participant's current one, so a job
 * admitted under a revoked grant stays blocked even when an identical-looking
 * replacement grant now exists.
 */
export type GroupAuthorizationBinding = Readonly<{
  groupId: string
  grantId: string
  revision: number
}>

export type GroupGrantState = 'effective' | 'expired' | 'not_yet_issued' | 'revoked'

export const groupGrantStates = [
  'effective',
  'expired',
  'not_yet_issued',
  'revoked',
] as const satisfies readonly GroupGrantState[]

/**
 * Explicit admission of one human into a group's audience. The grant is bound
 * to the group it was issued for: at admission the requested group must equal
 * `groupId`, and the authorization retained on the admission is sourced from
 * the grant — never relabelled from the request.
 */
export type GroupAudienceGrant = GroupGrantWindow &
  GroupGrantIdentity &
  Readonly<{
    /** The group this grant was issued for; it authorizes nothing elsewhere. */
    groupId: string
    /** The exact human this grant admits; it admits no one else. */
    participant: UserPrincipalRef
  }>

/**
 * Explicit enlistment of one Agent into a group, bound to its qualified
 * identity. Like every participation grant it is bound to the group it was
 * issued for and never authorizes a different one.
 */
export type GroupAgentEnlistmentGrant = GroupGrantWindow &
  GroupGrantIdentity &
  Readonly<{
    /** The exact Agent enlisted; a same-named Agent elsewhere is a different identity. */
    agent: QualifiedAgentIdentity
    /** The group this grant was issued for; it authorizes nothing elsewhere. */
    groupId: string
  }>

export const groupSharingScopes = ['earlier_history', 'earlier_summary'] as const

export type GroupSharingScope = (typeof groupSharingScopes)[number]

export function isGroupSharingScope(value: unknown): value is GroupSharingScope {
  return typeof value === 'string' && (groupSharingScopes as readonly string[]).includes(value)
}

/**
 * An audience-aware sharing grant: it extends one specific participant's
 * visibility past their join point. History sharing and summary sharing are
 * separately grantable — one scope never implies the other. Like every grant
 * it carries an identity and revision and is bound to the group it was issued
 * for: it unlocks earlier material only for decisions in that group.
 */
export type GroupSharingGrant = GroupGrantWindow &
  GroupGrantIdentity &
  Readonly<{
    /** The group this grant was issued for; it authorizes nothing elsewhere. */
    groupId: string
    /** The exact participant the earlier material is shared with. */
    participant: ConversationParticipantRef
    scope: GroupSharingScope
  }>

/**
 * Where a participant joined the group's history: admitted at `joinedAt`,
 * seeing conversation sequences at or after `joinedSequence` by default.
 */
export type GroupJoinPoint = Readonly<{
  joinedAt: string
  joinedSequence: number
}>

/**
 * One participant's standing in a group. `grant` is the explicit
 * participation grant (audience or enlistment) that admitted them; its window
 * governs participation, so revoking it denies future reads and turns
 * immediately. `authorization` retains exactly which group, grant and
 * revision authorized them, so late publication can compare it with the
 * binding a job retained.
 */
export type GroupAdmission = Readonly<{
  /** The group, grant identity and revision that currently authorize this member. */
  authorization: GroupAuthorizationBinding
  grant: GroupGrantWindow
  joinPoint: GroupJoinPoint
  participant: ConversationParticipantRef
}>

export type GroupCreationHumanCandidate = Readonly<{
  /** The explicit audience grant admitting this human, or null when none exists. */
  audienceGrant: GroupAudienceGrant | null
  kind: 'human'
  participant: UserPrincipalRef
  /** The workspace the caller resolved this human's membership in; it must equal the group's. */
  workspaceId: string
}>

export type GroupCreationAgentCandidate = Readonly<
  {
    /** The explicit enlistment grant for this Agent, or null when none exists. */
    enlistmentGrant: GroupAgentEnlistmentGrant | null
    kind: 'agent'
  } & QualifiedAgentIdentity
>

export type GroupCreationCandidate = GroupCreationHumanCandidate | GroupCreationAgentCandidate

export type GroupCreationInput = Readonly<{
  candidates: readonly GroupCreationCandidate[]
  /** The group being created; it is retained in every admission's binding. */
  groupId: string
  /** Admission time used for deterministic grant-window checks. */
  now: string
  /** The owning workspace bounding the group; every participant must belong to it. */
  workspaceId: string
}>

export type GroupCreationRejectionReason =
  | 'audience_empty'
  | 'audience_requires_human'
  | 'duplicate_participant'
  | 'grant_absent'
  | 'grant_expired'
  | 'grant_id_missing'
  | 'grant_mismatched_group'
  | 'grant_mismatched_participant'
  | 'grant_not_yet_issued'
  | 'grant_revision_invalid'
  | 'grant_revoked'
  | 'group_id_missing'
  | 'group_workspace_missing'
  | 'participant_cross_tenant'
  | 'participant_unqualified'

export const groupCreationRejectionReasons = [
  'audience_empty',
  'audience_requires_human',
  'duplicate_participant',
  'grant_absent',
  'grant_expired',
  'grant_id_missing',
  'grant_mismatched_group',
  'grant_mismatched_participant',
  'grant_not_yet_issued',
  'grant_revision_invalid',
  'grant_revoked',
  'group_id_missing',
  'group_workspace_missing',
  'participant_cross_tenant',
  'participant_unqualified',
] as const satisfies readonly GroupCreationRejectionReason[]

/**
 * One all-or-nothing creation failure. Candidate-scope rejections carry the
 * participant and their typed reason so the caller can enumerate every
 * invalid participant; group-scope rejections are about the group itself.
 */
export type GroupCreationRejection =
  | Readonly<{
      candidateIndex: number
      participant: ConversationParticipantRef
      reason: Exclude<
        GroupCreationRejectionReason,
        'audience_empty' | 'audience_requires_human' | 'group_workspace_missing'
      >
      scope: 'candidate'
    }>
  | Readonly<{
      reason:
        | 'audience_empty'
        | 'audience_requires_human'
        | 'group_id_missing'
        | 'group_workspace_missing'
      scope: 'group'
    }>

/**
 * Creation validation is all-or-nothing: one invalid participant fails the
 * whole creation, with every rejection enumerated. There is no partial
 * roster on failure.
 */
export type GroupCreationValidation =
  | Readonly<{ ok: true; roster: readonly GroupAdmission[] }>
  | Readonly<{ ok: false; rejections: readonly GroupCreationRejection[] }>

/** A piece of group history located in the conversation's sequence order. */
export type GroupHistoryEntryRef = Readonly<{
  occurredAt: string
  sequence: number
}>

/**
 * The grant-identity rejection reasons admission and every grant-consuming
 * decision share: a blank grant id, a revision that is not a positive safe
 * integer, or a grant issued for another group proves nothing and authorizes
 * nothing on any path. Decision paths re-run the same validation admission
 * performs, so an unprovable grant fails closed everywhere with these typed
 * reasons and never grants anything.
 */
export type GroupGrantIdentityRejectionReason =
  | 'grant_id_missing'
  | 'grant_revision_invalid'
  | 'grant_mismatched_group'

export const groupGrantIdentityRejectionReasons = [
  'grant_id_missing',
  'grant_revision_invalid',
  'grant_mismatched_group',
] as const satisfies readonly GroupGrantIdentityRejectionReason[]

export type GroupHistoryReadInput = Readonly<{
  /** The reader's admission, or null when they were never admitted. */
  admission: GroupAdmission | null
  entry: GroupHistoryEntryRef
  /**
   * The group whose history is being read. The admission's retained binding
   * and every sharing grant must be bound to it: nothing authorizes a read
   * into another group's history.
   */
  groupId: string
  /** Evaluation time used for deterministic grant-window checks. */
  now: string
  /** The group's sharing grants; policy checks the ones scoped to this reader. */
  sharingGrants: readonly GroupSharingGrant[]
}>

export type GroupHistoryReadDecision =
  | Readonly<{
      action: 'allow'
      basis: 'earlier_history_grant' | 'within_join_point'
      participationState: GroupGrantState
    }>
  | Readonly<{
      action: 'deny'
      /** Absent exactly when the reader was never admitted. */
      participationState?: GroupGrantState
      reason:
        | GroupGrantIdentityRejectionReason
        | 'history_before_join_point'
        | 'history_not_participant'
        | 'history_participation_revoked'
    }>

export type GroupSummaryReadInput = Readonly<{
  /** The reader's admission, or null when they were never admitted. */
  admission: GroupAdmission | null
  /**
   * The group whose summary is being read. The admission's retained binding
   * and every sharing grant must be bound to it: nothing authorizes a read
   * into another group's summary.
   */
  groupId: string
  /** The earliest conversation sequence the summary covers. */
  fromSequence: number
  /** Evaluation time used for deterministic grant-window checks. */
  now: string
  sharingGrants: readonly GroupSharingGrant[]
}>

export type GroupSummaryReadDecision =
  | Readonly<{
      action: 'allow'
      basis: 'earlier_summary_grant' | 'within_join_point'
      participationState: GroupGrantState
    }>
  | Readonly<{
      action: 'deny'
      /** Absent exactly when the reader was never admitted. */
      participationState?: GroupGrantState
      reason:
        | GroupGrantIdentityRejectionReason
        | 'summary_before_join_point'
        | 'summary_not_participant'
        | 'summary_participation_revoked'
    }>

export type GroupTurnInput = Readonly<{
  /** The participant's admission, or null when they were never admitted. */
  admission: GroupAdmission | null
  /**
   * The group the turn is taken in. The admission's retained binding must be
   * bound to it: one group's admission never takes turns in another.
   */
  groupId: string
  /** Evaluation time used for deterministic grant-window checks. */
  now: string
}>

export type GroupTurnDecision =
  | Readonly<{ action: 'allow' }>
  | Readonly<{
      action: 'deny'
      /** Absent exactly when the participant was never admitted. */
      participationState?: GroupGrantState
      reason:
        | GroupGrantIdentityRejectionReason
        | 'turn_not_participant'
        | 'turn_participation_revoked'
    }>

/**
 * A job that finished work on the group's behalf. Its lifecycle stays
 * independently owned. `authorization` is the binding retained when the job
 * was admitted under a group grant — `null` when the job is not group-bound —
 * and is compared against current authorization before late publication.
 */
export type GroupCompletedJob = Readonly<{
  /** The retained authorizing group, grant identity and revision, or null when not group-bound. */
  authorization: GroupAuthorizationBinding | null
  completedAt: string
  jobId: string
  /** The participant the job's authority is bound to; publication never transfers it. */
  participant: ConversationParticipantRef
}>

export type GroupPublicationInput = Readonly<{
  /** The publisher's admission, or null when they were never admitted. */
  admission: GroupAdmission | null
  job: GroupCompletedJob
  now: string
  publisher: ConversationParticipantRef
}>

export type GroupPublicationHoldReason =
  | 'publication_authority_mismatch'
  | 'publication_binding_mismatch'
  | 'publication_participation_revoked'
  | 'publication_participation_stale'
  | 'publication_unauthorized_at_completion'

export const groupPublicationHoldReasons = [
  'publication_authority_mismatch',
  'publication_binding_mismatch',
  'publication_participation_revoked',
  'publication_participation_stale',
  'publication_unauthorized_at_completion',
] as const satisfies readonly GroupPublicationHoldReason[]

/**
 * Revocation as a publication gate, not a job kill: a `hold` decision keeps
 * one result out of the group and says nothing about the independently owned
 * job, which is never cancelled or reassigned here.
 */
export type GroupPublicationDecision =
  | Readonly<{ action: 'publish'; basis: 'participant_authorized'; jobId: string }>
  | Readonly<{ action: 'hold'; jobId: string; reason: GroupPublicationHoldReason }>
