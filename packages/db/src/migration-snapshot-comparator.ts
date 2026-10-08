// Read-only comparator for frozen BEFORE/AFTER migration snapshots
// (M18.01, issue #1181).
//
// This is comparison tooling for migration rehearsal, not migration
// acceptance: it consumes two bounded, structured snapshot documents and
// reports typed findings. It cannot backfill, delete, cut over or roll
// anything back — every function here is pure and every input is a frozen
// document, so the module is structurally incapable of touching a database.
//
// Epistemics are fail-closed. A family section absent from a document makes
// that domain unknown, never zero. A section flagged truncated yields a
// finding, so an incomplete scan can never read as a clean one. A malformed
// or audience-ambiguous record is quarantined and excluded from matching
// rather than guessed at. Identity mismatches between the two snapshots are
// a typed error, not a diff. Output is deterministic: sorted findings, sorted
// counts, no timestamps, and no message bodies or credentials — the record
// contract (see `@adea-ai/types` migration-snapshot) excludes those fields,
// and findings only ever carry allow-listed detail keys.

import { createHash } from 'node:crypto'

import type {
  MigrationSnapshotComparison,
  MigrationSnapshotDocument,
  MigrationSnapshotFamily,
  MigrationSnapshotFamilyInventory,
  MigrationSnapshotFinding,
  MigrationSnapshotFindingClass,
  MigrationSnapshotRecord,
  MigrationSnapshotSection,
} from '@adea-ai/types'
import {
  MIGRATION_SNAPSHOT_FORMAT_VERSION,
  migrationSnapshotFamilies,
  migrationSnapshotRecordIssue,
} from '@adea-ai/types'

/** The two snapshots do not describe the same rehearsal, format or source. */
export class MigrationSnapshotIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationSnapshotIdentityError'
  }
}

// ─── Family comparison table ─────────────────────────────────────────────────

/**
 * How one family's matched records are compared.
 *
 * - `binding` fields are the record's identity binding: same stable id with a
 *   changed binding is a remap, not an attribute edit.
 * - `digests` are content-addressed fields: any drift is digest drift.
 * - `attributes` are compared for equality; `widened` marks the access-bearing
 *   fields whose growth is reported as widened access.
 */
type FamilyComparison = Readonly<{
  attributes: readonly Readonly<{ field: string; widened?: boolean }>[]
  binding: readonly string[]
  digests: readonly string[]
}>

const WORKSPACE_ROLE_RANK: Readonly<Record<string, number>> = { admin: 2, member: 1, owner: 3 }
const INVITATION_ROLE_RANK: Readonly<Record<string, number>> = { admin: 2, member: 1 }
const PROJECT_MEMBER_ROLE_RANK: Readonly<Record<string, number>> = { editor: 2, viewer: 1 }

function roleGrew(rank: Readonly<Record<string, number>>) {
  return (before: string, after: string) => (rank[after] ?? 0) > (rank[before] ?? 0)
}

function visibilityGrew(before: string, after: string): boolean {
  return before !== 'workspace' && after === 'workspace'
}

const FAMILY_COMPARISONS: Readonly<Record<MigrationSnapshotFamily, FamilyComparison>> = {
  agents: {
    attributes: [{ field: 'lifecycleState' }],
    binding: ['projectId', 'workspaceId'],
    digests: [],
  },
  channelParticipants: { attributes: [], binding: [], digests: [] },
  channels: {
    attributes: [{ field: 'visibility', widened: true }],
    binding: ['projectId', 'workspaceId'],
    digests: [],
  },
  contentRefs: {
    attributes: [{ field: 'availability' }],
    binding: ['messageId', 'taskId', 'workspaceId'],
    digests: ['digestSha256', 'keyVersion', 'revision'],
  },
  events: {
    attributes: [],
    binding: ['eventType', 'workspaceId', 'workspaceSequence'],
    digests: ['payloadDigest', 'schemaVersion'],
  },
  executionAttempts: {
    // Owner binding; the finding class is chosen per row (only a row that is
    // the active attempt on BOTH sides reports a conflicting owner).
    attributes: [],
    binding: ['locationKind', 'runtimeNodeId'],
    digests: [],
  },
  identityBindings: { attributes: [], binding: ['userId'], digests: [] },
  invitations: {
    attributes: [
      { field: 'invitedByUserId' },
      { field: 'role', widened: true },
      { field: 'state' },
    ],
    binding: ['workspaceId'],
    digests: [],
  },
  memberships: {
    attributes: [{ field: 'role', widened: true }],
    binding: [],
    digests: [],
  },
  messages: {
    attributes: [{ field: 'deleted' }],
    binding: ['channelId', 'threadRootMessageId', 'workspaceId'],
    digests: [],
  },
  projectMembers: {
    attributes: [{ field: 'role', widened: true }],
    binding: [],
    digests: [],
  },
  projects: {
    attributes: [{ field: 'visibility', widened: true }],
    binding: ['workspaceId'],
    digests: [],
  },
  readState: {
    // `lastReadSequence` is compared directionally (lost_read_state on
    // regression) outside this table; `manuallyUnread` here.
    attributes: [{ field: 'manuallyUnread' }],
    binding: [],
    digests: [],
  },
  tasks: {
    attributes: [{ field: 'lifecycleState' }, { field: 'version' }],
    binding: [
      'channelId',
      'creatorUserId',
      'messageId',
      'projectId',
      'threadRootMessageId',
      'workspaceId',
    ],
    digests: [],
  },
  temporarySessions: {
    attributes: [{ field: 'claimed' }],
    binding: ['userId'],
    digests: [],
  },
  workspaces: {
    attributes: [{ field: 'archived' }],
    binding: ['controlPlaneWorkspaceId', 'ownerUserId'],
    digests: [],
  },
}

/** Families whose rows ARE grants or audience membership: a new row in the
 *  after snapshot is widened access, not merely an unexpected record. */
const GRANT_FAMILIES: ReadonlySet<MigrationSnapshotFamily> = new Set([
  'channelParticipants',
  'memberships',
  'projectMembers',
])

const DETERMINATE_CLASSES: ReadonlySet<MigrationSnapshotFindingClass> = new Set([
  'changed_attribute',
  'conflicting_attempt_owner',
  'digest_drift',
  'duplicated_record',
  'lost_read_state',
  'missing_record',
  'remapped_record',
  'unexpected_record',
  'widened_access',
])

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asText(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return String(value)
}

/** Stable identity of a valid record, per family. */
function stableIdOf(record: MigrationSnapshotRecord): string {
  switch (record.family) {
    case 'agents':
      return record.agentId
    case 'channelParticipants':
      return `${record.channelId}:${record.principalKind}:${record.principalId}`
    case 'channels':
      return record.channelId
    case 'contentRefs':
      return record.contentRefId
    case 'events':
      return record.eventId
    case 'executionAttempts':
      return `${record.taskId}:${record.attempt}`
    case 'identityBindings':
      return `${record.provider}:${record.subject}`
    case 'invitations':
      return record.invitationId
    case 'memberships':
      return `${record.workspaceId}:${record.userId}`
    case 'messages':
      return record.messageId
    case 'projectMembers':
      return `${record.projectId}:${record.userId}`
    case 'projects':
      return record.projectId
    case 'readState':
      return `${record.workspaceId}:${record.userId}:${record.channelId}:${record.threadRootMessageId ?? '-'}`
    case 'tasks':
      return record.taskId
    case 'temporarySessions':
      return record.sessionId
    case 'workspaces':
      return record.workspaceId
  }
}

/**
 * Deterministic content identity for a record that failed validation, whose
 * real stable id cannot be trusted. Hashing keeps the finding referable
 * without echoing whatever the malformed field held.
 */
function quarantinedId(record: MigrationSnapshotRecord): string {
  const digest = createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex')
  return `unverifiable:${digest}`
}

type Detail = MigrationSnapshotFinding['detail']

function findingId(
  findingClass: MigrationSnapshotFindingClass,
  family: MigrationSnapshotFamily,
  side: MigrationSnapshotFinding['side'],
  stableId: string,
  field?: string
): string {
  return [findingClass, family, side, stableId, ...(field ? [field] : [])].join(':')
}

class FindingCollector {
  private readonly ids = new Set<string>()
  readonly findings: MigrationSnapshotFinding[] = []

  add(
    findingClass: MigrationSnapshotFindingClass,
    family: MigrationSnapshotFamily,
    side: MigrationSnapshotFinding['side'],
    stableId: string,
    detail: Detail = {}
  ): void {
    const field = typeof detail.field === 'string' ? detail.field : undefined
    const id = findingId(findingClass, family, side, stableId, field)
    if (this.ids.has(id)) return
    this.ids.add(id)
    this.findings.push({ detail, family, findingClass, id, side, stableId })
  }
}

// ─── Per-family record diff ──────────────────────────────────────────────────

type FieldDelta = Readonly<{
  detail: Detail
  findingClass: MigrationSnapshotFindingClass
}>

function delta(
  findingClass: MigrationSnapshotFindingClass,
  field: string,
  before: string,
  after: string
): FieldDelta {
  return { detail: { after, before, field }, findingClass }
}

function compareMatchedRecords(
  family: MigrationSnapshotFamily,
  before: MigrationSnapshotRecord,
  after: MigrationSnapshotRecord,
  activeAttemptBoth: boolean
): FieldDelta[] {
  const comparison = FAMILY_COMPARISONS[family]
  const deltas: FieldDelta[] = []
  const beforeFields = before as Readonly<Record<string, unknown>>
  const afterFields = after as Readonly<Record<string, unknown>>

  for (const field of comparison.binding) {
    if (beforeFields[field] !== afterFields[field]) {
      deltas.push(
        delta('remapped_record', field, asText(beforeFields[field]), asText(afterFields[field]))
      )
    }
  }
  for (const field of comparison.digests) {
    if (beforeFields[field] !== afterFields[field]) {
      deltas.push(
        delta('digest_drift', field, asText(beforeFields[field]), asText(afterFields[field]))
      )
    }
  }
  for (const attribute of comparison.attributes) {
    const { field } = attribute
    if (beforeFields[field] === afterFields[field]) continue
    if (attribute.widened && field === 'role') {
      const grew =
        family === 'memberships'
          ? roleGrew(WORKSPACE_ROLE_RANK)
          : family === 'projectMembers'
            ? roleGrew(PROJECT_MEMBER_ROLE_RANK)
            : roleGrew(INVITATION_ROLE_RANK)
      deltas.push(
        delta(
          grew(asText(beforeFields[field]), asText(afterFields[field]))
            ? 'widened_access'
            : 'changed_attribute',
          field,
          asText(beforeFields[field]),
          asText(afterFields[field])
        )
      )
      continue
    }
    if (attribute.widened && field === 'visibility') {
      const grew = visibilityGrew(asText(beforeFields[field]), asText(afterFields[field]))
      deltas.push(
        delta(
          grew ? 'widened_access' : 'changed_attribute',
          field,
          asText(beforeFields[field]),
          asText(afterFields[field])
        )
      )
      continue
    }
    deltas.push(
      delta('changed_attribute', field, asText(beforeFields[field]), asText(afterFields[field]))
    )
  }

  // Directional comparisons the table cannot express.
  if (family === 'readState') {
    const beforeFrontier = (before as { lastReadSequence: number }).lastReadSequence
    const afterFrontier = (after as { lastReadSequence: number }).lastReadSequence
    if (afterFrontier < beforeFrontier) {
      deltas.push(
        delta('lost_read_state', 'lastReadSequence', String(beforeFrontier), String(afterFrontier))
      )
    } else if (afterFrontier > beforeFrontier) {
      deltas.push(
        delta(
          'changed_attribute',
          'lastReadSequence',
          String(beforeFrontier),
          String(afterFrontier)
        )
      )
    }
  }
  if (family === 'executionAttempts') {
    // Only a row that is the active attempt on BOTH sides reports a
    // conflicting owner; any other owner drift on a matched row is an
    // attribute change.
    return deltas.map((item) =>
      item.findingClass === 'remapped_record'
        ? {
            detail: item.detail,
            findingClass: activeAttemptBoth ? 'conflicting_attempt_owner' : 'changed_attribute',
          }
        : item
    )
  }
  return deltas
}

// ─── Section intake ──────────────────────────────────────────────────────────

type Side = MigrationSnapshotFinding['side']

type IntakeResult = Readonly<{
  activeAttempts: ReadonlyMap<string, number>
  byStableId: ReadonlyMap<string, MigrationSnapshotRecord>
}>

function intakeSection(
  section: MigrationSnapshotSection,
  family: MigrationSnapshotFamily,
  side: Exclude<Side, 'both'>,
  collector: FindingCollector
): IntakeResult {
  const byStableId = new Map<string, MigrationSnapshotRecord>()
  const occurrences = new Map<string, number>()
  const activeByTask = new Map<string, number>()

  for (const record of section.records) {
    const issue = migrationSnapshotRecordIssue(record)
    if (issue) {
      collector.add('quarantined_record', family, side, quarantinedId(record), {
        field: issue.field,
        reason: issue.kind,
      })
      continue
    }
    const stableId = stableIdOf(record)
    occurrences.set(stableId, (occurrences.get(stableId) ?? 0) + 1)
    if (!byStableId.has(stableId)) byStableId.set(stableId, record)
    if (record.family === 'executionAttempts') {
      const current = activeByTask.get(record.taskId)
      if (current === undefined || record.attempt > current) {
        activeByTask.set(record.taskId, record.attempt)
      }
    }
  }
  for (const [stableId, count] of occurrences) {
    if (count > 1) {
      collector.add('duplicated_record', family, side, stableId, { count: String(count) })
    }
  }
  if (section.truncated) {
    collector.add('truncated_input', family, side, '*', { reason: 'truncated' })
  }
  return { activeAttempts: activeByTask, byStableId }
}

// ─── Identity ────────────────────────────────────────────────────────────────

function requireMatchingIdentity(
  before: MigrationSnapshotDocument,
  after: MigrationSnapshotDocument
): void {
  const fields: readonly (keyof MigrationSnapshotDocument['identity'])[] = [
    'rehearsalId',
    'formatVersion',
    'source',
  ]
  for (const field of fields) {
    const beforeValue = before.identity[field]
    const afterValue = after.identity[field]
    if (beforeValue === afterValue) continue
    throw new MigrationSnapshotIdentityError(
      `Snapshot identity mismatch on ${field}: the before and after snapshots must describe the same rehearsal, format and source`
    )
  }
  for (const [label, identity] of [
    ['before', before.identity],
    ['after', after.identity],
  ] as const) {
    if (
      typeof identity.rehearsalId !== 'string' ||
      identity.rehearsalId.length === 0 ||
      typeof identity.source !== 'string' ||
      identity.source.length === 0 ||
      typeof identity.snapshotId !== 'string' ||
      identity.snapshotId.length === 0 ||
      identity.formatVersion !== MIGRATION_SNAPSHOT_FORMAT_VERSION
    ) {
      throw new MigrationSnapshotIdentityError(
        `Snapshot identity malformed on the ${label} document: rehearsalId, snapshotId, source and formatVersion must be present and the format must be version ${MIGRATION_SNAPSHOT_FORMAT_VERSION}`
      )
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Compare a frozen BEFORE snapshot against a frozen AFTER snapshot and return
 * the complete, deterministic finding set. Throws
 * `MigrationSnapshotIdentityError` when the two documents do not carry the
 * same rehearsal id, format version and source, or when either identity is
 * malformed — a mismatch is an input error, never a diff.
 *
 * Pure and read-only: no database, no mutation, no side effects.
 */
export function compareMigrationSnapshots(
  input: Readonly<{
    after: MigrationSnapshotDocument
    before: MigrationSnapshotDocument
  }>
): MigrationSnapshotComparison {
  requireMatchingIdentity(input.before, input.after)
  const collector = new FindingCollector()
  const inventory: MigrationSnapshotFamilyInventory[] = []

  for (const family of migrationSnapshotFamilies) {
    const beforeSection = input.before.sections[family]
    const afterSection = input.after.sections[family]

    if (!beforeSection && !afterSection) {
      collector.add('unknown_domain', family, 'both', '*', { reason: 'section_absent' })
      inventory.push({ after: null, before: null, family })
      continue
    }
    if (!beforeSection || !afterSection) {
      const side: Side = beforeSection ? 'after' : 'before'
      collector.add('unknown_domain', family, side, '*', { reason: 'section_absent' })
      inventory.push({
        after: afterSection ? afterSection.records.length : null,
        before: beforeSection ? beforeSection.records.length : null,
        family,
      })
      continue
    }

    const beforeIntake = intakeSection(beforeSection, family, 'before', collector)
    const afterIntake = intakeSection(afterSection, family, 'after', collector)

    for (const [stableId, beforeRecord] of beforeIntake.byStableId) {
      const afterRecord = afterIntake.byStableId.get(stableId)
      if (!afterRecord) {
        collector.add('missing_record', family, 'after', stableId)
        continue
      }
      // Only a row that is its task's active attempt (highest attempt number)
      // on BOTH sides can report a conflicting attempt owner.
      const activeAttemptBoth =
        beforeRecord.family === 'executionAttempts' &&
        afterRecord.family === 'executionAttempts' &&
        beforeIntake.activeAttempts.get(beforeRecord.taskId) === beforeRecord.attempt &&
        afterIntake.activeAttempts.get(afterRecord.taskId) === afterRecord.attempt
      for (const item of compareMatchedRecords(
        family,
        beforeRecord,
        afterRecord,
        activeAttemptBoth
      )) {
        collector.add(item.findingClass, family, 'both', stableId, item.detail)
      }
    }
    for (const [stableId] of afterIntake.byStableId) {
      if (beforeIntake.byStableId.has(stableId)) continue
      if (GRANT_FAMILIES.has(family)) {
        collector.add('widened_access', family, 'after', stableId, { field: 'grant' })
        continue
      }
      collector.add('unexpected_record', family, 'after', stableId)
    }

    inventory.push({
      after: afterSection.records.length,
      before: beforeSection.records.length,
      family,
    })
  }

  const findings = [...collector.findings].toSorted((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  )

  const byClass = new Map<MigrationSnapshotFindingClass, number>()
  const byFamily = new Map<MigrationSnapshotFamily, number>()
  let determinate = 0
  let epistemic = 0
  for (const finding of findings) {
    byClass.set(finding.findingClass, (byClass.get(finding.findingClass) ?? 0) + 1)
    byFamily.set(finding.family, (byFamily.get(finding.family) ?? 0) + 1)
    if (DETERMINATE_CLASSES.has(finding.findingClass)) determinate += 1
    else epistemic += 1
  }

  const countsByClass: Partial<Record<MigrationSnapshotFindingClass, number>> = {}
  for (const findingClass of [...byClass.keys()].toSorted()) {
    countsByClass[findingClass] = byClass.get(findingClass)
  }
  const countsByFamily: Partial<Record<MigrationSnapshotFamily, number>> = {}
  for (const family of [...byFamily.keys()].toSorted()) {
    countsByFamily[family] = byFamily.get(family)
  }

  return Object.freeze({
    counts: Object.freeze({ byClass: countsByClass, byFamily: countsByFamily }),
    findings: Object.freeze(findings),
    inventory: Object.freeze(inventory),
    verdict: determinate > 0 ? 'divergent' : epistemic > 0 ? 'inconclusive' : 'identical',
  })
}
