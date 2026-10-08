/**
 * Group audience and participation types for M15 #1178.
 *
 * This module holds the identity, grant, decision and typed-rejection shapes
 * for tenant-bounded groups: explicit human audience grants, explicit Agent
 * enlistment grants, join-point history policy and revocation. It is consumed
 * by the pure policy functions in `@adea-ai/db`'s
 * `group-participation-policy` module and deliberately contains no I/O:
 * atomic group creation, live enlistment and publication are later
 * integration slices.
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
 * absent) and `revokedAt` ends it immediately.
 */
export type GroupGrantWindow = Readonly<{
  expiresAt: string | null
  issuedAt: string
  revokedAt: string | null
}>

export type GroupGrantState = 'effective' | 'expired' | 'not_yet_issued' | 'revoked'

export const groupGrantStates = [
  'effective',
  'expired',
  'not_yet_issued',
  'revoked',
] as const satisfies readonly GroupGrantState[]

/** Explicit admission of one human into a group's audience. */
export type GroupAudienceGrant = GroupGrantWindow &
  Readonly<{
    grantId: string
    /** The exact human this grant admits; it admits no one else. */
    participant: UserPrincipalRef
  }>

/** Explicit enlistment of one Agent into a group, bound to its qualified identity. */
export type GroupAgentEnlistmentGrant = GroupGrantWindow &
  Readonly<{
    /** The exact Agent enlisted; a same-named Agent elsewhere is a different identity. */
    agent: QualifiedAgentIdentity
    grantId: string
  }>

export const groupSharingScopes = ['earlier_history', 'earlier_summary'] as const

export type GroupSharingScope = (typeof groupSharingScopes)[number]

export function isGroupSharingScope(value: unknown): value is GroupSharingScope {
  return typeof value === 'string' && (groupSharingScopes as readonly string[]).includes(value)
}

/**
 * An audience-aware sharing grant: it extends one specific participant's
 * visibility past their join point. History sharing and summary sharing are
 * separately grantable — one scope never implies the other.
 */
export type GroupSharingGrant = GroupGrantWindow &
  Readonly<{
    grantId: string
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
 * immediately.
 */
export type GroupAdmission = Readonly<{
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
  | 'grant_mismatched_participant'
  | 'grant_not_yet_issued'
  | 'grant_revoked'
  | 'group_workspace_missing'
  | 'participant_cross_tenant'
  | 'participant_unqualified'

export const groupCreationRejectionReasons = [
  'audience_empty',
  'audience_requires_human',
  'duplicate_participant',
  'grant_absent',
  'grant_expired',
  'grant_mismatched_participant',
  'grant_not_yet_issued',
  'grant_revoked',
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
      reason: 'audience_empty' | 'audience_requires_human' | 'group_workspace_missing'
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

export type GroupHistoryReadInput = Readonly<{
  /** The reader's admission, or null when they were never admitted. */
  admission: GroupAdmission | null
  entry: GroupHistoryEntryRef
  /** The group's sharing grants; policy checks the ones scoped to this reader. */
  now: string
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
        | 'history_before_join_point'
        | 'history_not_participant'
        | 'history_participation_revoked'
    }>

export type GroupSummaryReadInput = Readonly<{
  /** The reader's admission, or null when they were never admitted. */
  admission: GroupAdmission | null
  /** The earliest conversation sequence the summary covers. */
  fromSequence: number
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
        | 'summary_before_join_point'
        | 'summary_not_participant'
        | 'summary_participation_revoked'
    }>

export type GroupTurnInput = Readonly<{
  /** The participant's admission, or null when they were never admitted. */
  admission: GroupAdmission | null
  now: string
}>

export type GroupTurnDecision =
  | Readonly<{ action: 'allow' }>
  | Readonly<{
      action: 'deny'
      /** Absent exactly when the participant was never admitted. */
      participationState?: GroupGrantState
      reason: 'turn_not_participant' | 'turn_participation_revoked'
    }>

/** A job that finished work on the group's behalf. Its lifecycle stays independently owned. */
export type GroupCompletedJob = Readonly<{
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
  | 'publication_participation_revoked'
  | 'publication_participation_stale'
  | 'publication_unauthorized_at_completion'

export const groupPublicationHoldReasons = [
  'publication_authority_mismatch',
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
