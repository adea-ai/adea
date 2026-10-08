// Frozen migration-snapshot documents for migration rehearsal (M18.01, #1181).
//
// A snapshot document is a bounded, structured inventory of real product and
// runtime records captured from one deployment at one point in time: stable
// ids, history digests, audience and grant identities, conversation links,
// read frontiers and execution-attempt ownership. The comparator in
// `@adea-ai/db` consumes two frozen documents (before / after) and reports
// typed findings; it never touches a live database.
//
// The record shapes below are derived from what `packages/db/src` persists
// today (workspaces, memberships, invitations, auth identities, temporary
// sessions, projects, project members, channels, participants, messages,
// tasks, agents, content refs, durable events, read state, execution
// attempts). They deliberately carry NO message bodies, NO email addresses,
// NO tokens or token digests, NO ciphertext and NO key material — the record
// contract excludes every field a leak would need, so comparator output is
// clean by construction.
//
// Epistemics (fail-closed): a family section that is absent from a document
// makes that domain `unknown` — never zero. A scan that hit its bound is
// flagged `truncated`. A record that is malformed, or whose audience/ownership
// classification is ambiguous, is `quarantined` and excluded from matching.
// Inconclusive input can never yield a success verdict.

/**
 * Format version of the snapshot document contract. Bump it when a record
 * shape changes; the comparator refuses to compare documents that disagree.
 */
export const MIGRATION_SNAPSHOT_FORMAT_VERSION = 1

/**
 * Every record family a snapshot document may carry, in sorted order.
 * An omitted section means the capture could not inventory that domain —
 * it is reported as unknown, not as empty.
 */
export const migrationSnapshotFamilies = [
  'agents',
  'channelParticipants',
  'channels',
  'contentRefs',
  'events',
  'executionAttempts',
  'identityBindings',
  'invitations',
  'memberships',
  'messages',
  'projectMembers',
  'projects',
  'readState',
  'tasks',
  'temporarySessions',
  'workspaces',
] as const

export type MigrationSnapshotFamily = (typeof migrationSnapshotFamilies)[number]

export function isMigrationSnapshotFamily(value: unknown): value is MigrationSnapshotFamily {
  return (
    typeof value === 'string' && (migrationSnapshotFamilies as readonly string[]).includes(value)
  )
}

// ─── Enumerated values mirrored from the persisted schema ───────────────────

export const migrationWorkspaceRoles = ['admin', 'member', 'owner'] as const
export type MigrationWorkspaceRole = (typeof migrationWorkspaceRoles)[number]

export const migrationInvitationRoles = ['admin', 'member'] as const
export type MigrationInvitationRole = (typeof migrationInvitationRoles)[number]

/** Mirrors the derived invitation state in `packages/db/src/workspace-invitations.ts`. */
export const migrationInvitationStates = ['accepted', 'expired', 'pending', 'revoked'] as const
export type MigrationInvitationState = (typeof migrationInvitationStates)[number]

export const migrationProjectVisibilities = ['members', 'workspace'] as const
export type MigrationProjectVisibility = (typeof migrationProjectVisibilities)[number]

export const migrationProjectMemberRoles = ['editor', 'viewer'] as const
export type MigrationProjectMemberRole = (typeof migrationProjectMemberRoles)[number]

export const migrationChannelVisibilities = ['participants', 'workspace'] as const
export type MigrationChannelVisibility = (typeof migrationChannelVisibilities)[number]

/** Channel participants are user or agent principals. */
export const migrationParticipantKinds = ['agent', 'user'] as const
export type MigrationParticipantKind = (typeof migrationParticipantKinds)[number]

/** Mirrors `TaskLifecycleState` (kept local so this module stays dependency-free). */
export const migrationTaskLifecycleStates = [
  'archived',
  'cancelled',
  'completed',
  'created',
  'in_progress',
  'in_review',
  'queued',
] as const
export type MigrationTaskLifecycleState = (typeof migrationTaskLifecycleStates)[number]

/** Mirrors `AgentLifecycleState`. */
export const migrationAgentLifecycleStates = ['active', 'archived', 'configuration_error'] as const
export type MigrationAgentLifecycleState = (typeof migrationAgentLifecycleStates)[number]

/** Mirrors `ContentRefSummary['availability']`. */
export const migrationContentAvailabilities = [
  'available',
  'deleted',
  'missing',
  'offline',
] as const
export type MigrationContentAvailability = (typeof migrationContentAvailabilities)[number]

/** Mirrors `TaskExecutionLocation`. */
export const migrationExecutionLocationKinds = [
  'agent_hq_cloud',
  'local_device',
  'remote_host',
] as const
export type MigrationExecutionLocationKind = (typeof migrationExecutionLocationKinds)[number]

// ─── Records ─────────────────────────────────────────────────────────────────
//
// One record per persisted row that a migration must preserve. `family` is the
// discriminator; every other field is an identifier, an enum value, a digest,
// a monotonic number or a boolean — never free content.

/** A workspace: its stable id, control-plane scope and owner binding. */
export type WorkspaceSnapshotRecord = Readonly<{
  archived: boolean
  controlPlaneWorkspaceId: string
  family: 'workspaces'
  ownerUserId: string
  workspaceId: string
}>

/** A workspace membership: the workspace-level grant of one user. */
export type MembershipSnapshotRecord = Readonly<{
  family: 'memberships'
  role: MigrationWorkspaceRole
  userId: string
  workspaceId: string
}>

/** An invitation's lifecycle facts; the email and token never travel. */
export type InvitationSnapshotRecord = Readonly<{
  family: 'invitations'
  invitationId: string
  invitedByUserId: string
  role: MigrationInvitationRole
  state: MigrationInvitationState
  workspaceId: string
}>

/** An auth identity binding: one external identity resolves to one user. */
export type IdentityBindingSnapshotRecord = Readonly<{
  family: 'identityBindings'
  provider: string
  subject: string
  userId: string
}>

/** A temporary user session: ownership and claim state only. */
export type TemporarySessionSnapshotRecord = Readonly<{
  claimed: boolean
  family: 'temporarySessions'
  sessionId: string
  userId: string
}>

/** A project: its workspace and who may see it. */
export type ProjectSnapshotRecord = Readonly<{
  family: 'projects'
  projectId: string
  visibility: MigrationProjectVisibility
  workspaceId: string
}>

/** A members-project grant of one user. */
export type ProjectMemberSnapshotRecord = Readonly<{
  family: 'projectMembers'
  projectId: string
  role: MigrationProjectMemberRole
  userId: string
  workspaceId: string
}>

/** A channel: its workspace and project scope, and who can see it. */
export type ChannelSnapshotRecord = Readonly<{
  channelId: string
  family: 'channels'
  projectId: string | null
  visibility: MigrationChannelVisibility
  workspaceId: string
}>

/** One participant of a channel: the audience that can read it. */
export type ChannelParticipantSnapshotRecord = Readonly<{
  channelId: string
  family: 'channelParticipants'
  principalId: string
  principalKind: MigrationParticipantKind
  workspaceId: string
}>

/** A message's link facts only: channel, thread root, deletion. No body. */
export type MessageSnapshotRecord = Readonly<{
  channelId: string
  deleted: boolean
  family: 'messages'
  messageId: string
  threadRootMessageId: string | null
  workspaceId: string
}>

/** A task: its links (project, conversation, creator) and lifecycle facts. */
export type TaskSnapshotRecord = Readonly<{
  channelId: string | null
  creatorUserId: string
  family: 'tasks'
  lifecycleState: MigrationTaskLifecycleState
  messageId: string | null
  projectId: string | null
  taskId: string
  threadRootMessageId: string | null
  version: number
  workspaceId: string
}>

/** An agent: its workspace and project binding and lifecycle state. */
export type AgentSnapshotRecord = Readonly<{
  agentId: string
  family: 'agents'
  lifecycleState: MigrationAgentLifecycleState
  projectId: string | null
  workspaceId: string
}>

/** A content ref: digest, revision, key version, availability and links. */
export type ContentRefSnapshotRecord = Readonly<{
  availability: MigrationContentAvailability
  digestSha256: string
  family: 'contentRefs'
  keyVersion: number
  messageId: string | null
  contentRefId: string
  revision: number
  taskId: string | null
  workspaceId: string
}>

/**
 * One durable event: identity, replay anchor (workspace + sequence), contract
 * version and a caller-computed payload digest. The payload itself never
 * travels — the digest is what drift detection compares.
 */
export type EventSnapshotRecord = Readonly<{
  eventId: string
  eventType: string
  family: 'events'
  payloadDigest: string
  schemaVersion: number
  workspaceId: string
  workspaceSequence: number
}>

/**
 * One read frontier: channel-level when `threadRootMessageId` is null,
 * thread-level otherwise. The frontier is the read state a rollback must not
 * regress.
 */
export type ReadStateSnapshotRecord = Readonly<{
  channelId: string
  family: 'readState'
  lastReadSequence: number
  manuallyUnread: boolean
  threadRootMessageId: string | null
  userId: string
  workspaceId: string
}>

/** One recorded execution attempt: which owner (location, node) ran it. */
export type ExecutionAttemptSnapshotRecord = Readonly<{
  attempt: number
  family: 'executionAttempts'
  /** Null exactly for the reserved `agent_hq_cloud` location. */
  locationKind: MigrationExecutionLocationKind
  runtimeNodeId: string | null
  taskId: string
  workspaceId: string
}>

/** A frozen record of one family. */
export type MigrationSnapshotRecord =
  | AgentSnapshotRecord
  | ChannelParticipantSnapshotRecord
  | ChannelSnapshotRecord
  | ContentRefSnapshotRecord
  | EventSnapshotRecord
  | ExecutionAttemptSnapshotRecord
  | IdentityBindingSnapshotRecord
  | InvitationSnapshotRecord
  | MembershipSnapshotRecord
  | MessageSnapshotRecord
  | ProjectMemberSnapshotRecord
  | ProjectSnapshotRecord
  | ReadStateSnapshotRecord
  | TaskSnapshotRecord
  | TemporarySessionSnapshotRecord
  | WorkspaceSnapshotRecord

/** The record type a given family section holds. */
export type MigrationSnapshotRecordFor<F extends MigrationSnapshotFamily> = Extract<
  MigrationSnapshotRecord,
  { family: F }
>

// ─── Documents ───────────────────────────────────────────────────────────────

/**
 * Snapshot identity. `snapshotId` names this one capture; `rehearsalId`,
 * `formatVersion` and `source` must agree across the before/after pair —
 * a mismatch is a typed error, never a diff.
 */
export type MigrationSnapshotIdentity = Readonly<{
  formatVersion: number
  rehearsalId: string
  snapshotId: string
  source: string
}>

/**
 * One bounded family section. `records` may be empty — an empty array is a
 * proven fact ("this domain holds no records"), which is different from a
 * section that is absent (unknown). `truncated` must be true when the capture
 * stopped at `limit` before exhausting the domain.
 */
export type MigrationSnapshotSection<F extends MigrationSnapshotFamily = MigrationSnapshotFamily> =
  Readonly<{
    limit?: number
    records: readonly MigrationSnapshotRecordFor<F>[]
    truncated: boolean
  }>

/** The bounded inventory of one capture; absent sections are unknown domains. */
export type MigrationSnapshotSections = {
  readonly [F in MigrationSnapshotFamily]?: MigrationSnapshotSection<F>
}

/** A frozen snapshot document: identity plus bounded sections. */
export type MigrationSnapshotDocument = Readonly<{
  identity: MigrationSnapshotIdentity
  sections: MigrationSnapshotSections
}>

// ─── Findings and verdicts ───────────────────────────────────────────────────

/**
 * Every determinate violation class the comparator reports, followed by the
 * epistemic classes: input that cannot be compared never silently reads as
 * success.
 *
 * Determinate:
 * - `missing_record` — present before, absent after.
 * - `unexpected_record` — present after, absent before (non-grant families;
 *   a new grant row is `widened_access` instead).
 * - `duplicated_record` — the same stable id twice within one section.
 * - `remapped_record` — same stable id, changed identity binding.
 * - `digest_drift` — content digest, revision, key version or event payload
 *   digest changed for the same record.
 * - `widened_access` — a grant, audience or visibility grew.
 * - `lost_read_state` — a read frontier regressed.
 * - `conflicting_attempt_owner` — a task's active execution attempt is bound
 *   to a different owner after the migration.
 * - `changed_attribute` — any other determinate drift on a matched record.
 *
 * Epistemic:
 * - `unknown_domain` — a family section is absent; that domain is not proven.
 * - `quarantined_record` — a malformed or ambiguous record was excluded.
 * - `truncated_input` — a bounded section reports an incomplete scan.
 */
export const migrationSnapshotFindingClasses = [
  'changed_attribute',
  'conflicting_attempt_owner',
  'digest_drift',
  'duplicated_record',
  'lost_read_state',
  'missing_record',
  'quarantined_record',
  'remapped_record',
  'truncated_input',
  'unexpected_record',
  'unknown_domain',
  'widened_access',
] as const

export type MigrationSnapshotFindingClass = (typeof migrationSnapshotFindingClasses)[number]

/** Which snapshot a finding is about. */
export type MigrationSnapshotFindingSide = 'after' | 'before' | 'both'

/**
 * The only keys a finding's `detail` may carry. Values are identifiers, enum
 * values or counts the comparator itself derived — never echoed record
 * content, so a hostile extra property on an input record cannot surface.
 */
export const migrationSnapshotFindingDetailKeys = [
  'after',
  'before',
  'count',
  'field',
  'reason',
] as const

export type MigrationSnapshotFindingDetailKey = (typeof migrationSnapshotFindingDetailKeys)[number]

/** One typed finding: a stable, sanitizable, deterministically ordered fact. */
export type MigrationSnapshotFinding = Readonly<{
  detail: Readonly<Partial<Record<MigrationSnapshotFindingDetailKey, string>>>
  family: MigrationSnapshotFamily
  findingClass: MigrationSnapshotFindingClass
  /** Deterministic: `<class>:<family>:<side>:<stableId>[:<field>]`. */
  id: string
  side: MigrationSnapshotFindingSide
  stableId: string
}>

/**
 * - `identical` — zero findings: every known domain compared clean.
 * - `divergent` — at least one determinate violation.
 * - `inconclusive` — no determinate violation, but at least one unknown
 *   domain, quarantined record or truncated scan. Equality was not proven;
 *   inconclusive is never reported as success.
 */
export type MigrationSnapshotVerdict = 'divergent' | 'identical' | 'inconclusive'

/** Raw per-family record counts; `null` means the section was absent (unknown). */
export type MigrationSnapshotFamilyInventory = Readonly<{
  after: number | null
  before: number | null
  family: MigrationSnapshotFamily
}>

/** The complete, deterministic result of one comparison. */
export type MigrationSnapshotComparison = Readonly<{
  counts: Readonly<{
    byClass: Readonly<Partial<Record<MigrationSnapshotFindingClass, number>>>
    byFamily: Readonly<Partial<Record<MigrationSnapshotFamily, number>>>
  }>
  findings: readonly MigrationSnapshotFinding[]
  inventory: readonly MigrationSnapshotFamilyInventory[]
  verdict: MigrationSnapshotVerdict
}>

// ─── Record validation ───────────────────────────────────────────────────────

/**
 * Why a record was quarantined. `malformed`: a required field is missing or
 * of the wrong shape. `ambiguous`: the record is shaped but its audience or
 * ownership classification is not one of the known values, so the comparator
 * refuses to guess which side of an access comparison it belongs to.
 */
export type MigrationSnapshotRecordIssue =
  | Readonly<{ field: string; kind: 'ambiguous' }>
  | Readonly<{ field: string; kind: 'malformed' }>

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isInList<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/

type FieldCheck = Readonly<{ field: string; ok: boolean; kind?: 'ambiguous' }>

function check(field: string, ok: boolean): FieldCheck {
  return { field, ok }
}

/**
 * An enumerated audience/ownership field: absent is malformed (the record is
 * incomplete), present but not a known value is ambiguous (the record is
 * whole, but the comparator refuses to guess its classification).
 */
function enumField(field: string, value: unknown, values: readonly string[]): FieldCheck {
  if (value === undefined) return check(field, false)
  return { field, kind: 'ambiguous', ok: isInList(value, values) }
}

function firstIssue(checks: readonly FieldCheck[]): MigrationSnapshotRecordIssue | null {
  for (const item of checks) {
    if (!item.ok) return { field: item.field, kind: item.kind ?? 'malformed' }
  }
  return null
}

/**
 * Validate one record against the snapshot contract. Returns the first issue
 * found, or null when the record is well-formed and unambiguous. The issue
 * names the offending field and never echoes the offending value.
 */
export function migrationSnapshotRecordIssue(
  record: MigrationSnapshotRecord
): MigrationSnapshotRecordIssue | null {
  if (!isMigrationSnapshotFamily(record.family)) return { field: 'family', kind: 'malformed' }
  if (typeof record !== 'object' || record === null) return { field: 'family', kind: 'malformed' }

  switch (record.family) {
    case 'agents':
      return firstIssue([
        check('agentId', isNonEmptyString(record.agentId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('projectId', isNullableNonEmptyString(record.projectId)),
        enumField('lifecycleState', record.lifecycleState, migrationAgentLifecycleStates),
      ])
    case 'channelParticipants':
      return firstIssue([
        check('channelId', isNonEmptyString(record.channelId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('principalId', isNonEmptyString(record.principalId)),
        enumField('principalKind', record.principalKind, migrationParticipantKinds),
      ])
    case 'channels':
      return firstIssue([
        check('channelId', isNonEmptyString(record.channelId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('projectId', isNullableNonEmptyString(record.projectId)),
        enumField('visibility', record.visibility, migrationChannelVisibilities),
      ])
    case 'contentRefs':
      return firstIssue([
        check('contentRefId', isNonEmptyString(record.contentRefId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check(
          'digestSha256',
          isNonEmptyString(record.digestSha256) && DIGEST_PATTERN.test(record.digestSha256)
        ),
        check('revision', isNonNegativeSafeInteger(record.revision)),
        check('keyVersion', isNonNegativeSafeInteger(record.keyVersion)),
        check('messageId', isNullableNonEmptyString(record.messageId)),
        check('taskId', isNullableNonEmptyString(record.taskId)),
        enumField('availability', record.availability, migrationContentAvailabilities),
      ])
    case 'events':
      return firstIssue([
        check('eventId', isNonEmptyString(record.eventId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('workspaceSequence', isNonNegativeSafeInteger(record.workspaceSequence)),
        check('eventType', isNonEmptyString(record.eventType)),
        check('schemaVersion', isNonNegativeSafeInteger(record.schemaVersion)),
        check('payloadDigest', isNonEmptyString(record.payloadDigest)),
      ])
    case 'executionAttempts': {
      const base = firstIssue([
        check('taskId', isNonEmptyString(record.taskId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('attempt', isNonNegativeSafeInteger(record.attempt) && record.attempt > 0),
        enumField('locationKind', record.locationKind, migrationExecutionLocationKinds),
        check('runtimeNodeId', isNullableNonEmptyString(record.runtimeNodeId)),
      ])
      if (base) return base
      // Ownership is ambiguous when the location and node contradict each
      // other: the reserved cloud location owns no node, every other
      // location is owned by exactly one.
      const paired =
        record.locationKind === 'agent_hq_cloud'
          ? record.runtimeNodeId === null
          : record.runtimeNodeId !== null
      return paired ? null : { field: 'runtimeNodeId', kind: 'ambiguous' }
    }
    case 'identityBindings':
      return firstIssue([
        check('provider', isNonEmptyString(record.provider)),
        check('subject', isNonEmptyString(record.subject)),
        check('userId', isNonEmptyString(record.userId)),
      ])
    case 'invitations':
      return firstIssue([
        check('invitationId', isNonEmptyString(record.invitationId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('invitedByUserId', isNonEmptyString(record.invitedByUserId)),
        enumField('role', record.role, migrationInvitationRoles),
        enumField('state', record.state, migrationInvitationStates),
      ])
    case 'memberships':
      return firstIssue([
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('userId', isNonEmptyString(record.userId)),
        enumField('role', record.role, migrationWorkspaceRoles),
      ])
    case 'messages':
      return firstIssue([
        check('messageId', isNonEmptyString(record.messageId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('channelId', isNonEmptyString(record.channelId)),
        check('threadRootMessageId', isNullableNonEmptyString(record.threadRootMessageId)),
        check('deleted', isBoolean(record.deleted)),
      ])
    case 'projectMembers':
      return firstIssue([
        check('projectId', isNonEmptyString(record.projectId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('userId', isNonEmptyString(record.userId)),
        enumField('role', record.role, migrationProjectMemberRoles),
      ])
    case 'projects':
      return firstIssue([
        check('projectId', isNonEmptyString(record.projectId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        enumField('visibility', record.visibility, migrationProjectVisibilities),
      ])
    case 'readState':
      return firstIssue([
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('userId', isNonEmptyString(record.userId)),
        check('channelId', isNonEmptyString(record.channelId)),
        check('threadRootMessageId', isNullableNonEmptyString(record.threadRootMessageId)),
        check('lastReadSequence', isNonNegativeSafeInteger(record.lastReadSequence)),
        check('manuallyUnread', isBoolean(record.manuallyUnread)),
      ])
    case 'tasks':
      return firstIssue([
        check('taskId', isNonEmptyString(record.taskId)),
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('projectId', isNullableNonEmptyString(record.projectId)),
        check('channelId', isNullableNonEmptyString(record.channelId)),
        check('messageId', isNullableNonEmptyString(record.messageId)),
        check('threadRootMessageId', isNullableNonEmptyString(record.threadRootMessageId)),
        check('creatorUserId', isNonEmptyString(record.creatorUserId)),
        enumField('lifecycleState', record.lifecycleState, migrationTaskLifecycleStates),
        check('version', isNonNegativeSafeInteger(record.version) && record.version > 0),
      ])
    case 'temporarySessions':
      return firstIssue([
        check('sessionId', isNonEmptyString(record.sessionId)),
        check('userId', isNonEmptyString(record.userId)),
        check('claimed', isBoolean(record.claimed)),
      ])
    case 'workspaces':
      return firstIssue([
        check('workspaceId', isNonEmptyString(record.workspaceId)),
        check('controlPlaneWorkspaceId', isNonEmptyString(record.controlPlaneWorkspaceId)),
        check('ownerUserId', isNonEmptyString(record.ownerUserId)),
        check('archived', isBoolean(record.archived)),
      ])
  }
}
