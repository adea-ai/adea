/**
 * Portable workspace export, format version 1 (M18.02.2, #1226).
 *
 * A portable export is the requester's own view of one workspace as a
 * self-contained JSON document: stable IDs, timestamps, authors, audience
 * links, task/attempt relationships and content-ref metadata, restorable into a
 * clean environment by `@adea-ai/db`'s `importPortableWorkspace`. This module is
 * the contract only. It is pure (no I/O, no crypto) so the web client, desktop
 * shell and server share one validator; the database builder, importer and
 * content digest live in `@adea-ai/db`.
 *
 * What the format deliberately does NOT carry, and why, is declared in
 * `PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS` and travels inside every document so a
 * reader can tell an absent family from a withheld one:
 *
 * - credentials of any kind (sessions, invitation tokens and emails, identity
 *   bindings, runtime node keys, exchange credentials, desktop authorization);
 * - synchronized ciphertext and its keys (#193) and transient remote envelopes
 *   (#189): the export never holds material a reader could decrypt;
 * - local-authority content bodies: a content ref travels as metadata only;
 * - artifact bytes, storage locations and artifact links (#86): deferred until
 *   Agent HQ object storage promotion is operational;
 * - native checkpoints, native session files, runtime node bindings and
 *   execution references: runtime state is not portable, so only cloud-location
 *   attempts (the reserved `agent_hq_cloud` location) are recorded.
 *
 * Audience is enforced when the document is built, not here: a validator can
 * only prove that the document is internally consistent (closed references, no
 * unknown fields, no withheld placeholders with values), not who was allowed to
 * read it. Records outside the requester's audience are simply absent, and
 * links to them are cleared to null, so a document never names a hidden record.
 */

export const PORTABLE_WORKSPACE_EXPORT_FORMAT = 'adea.portable-workspace-export' as const
export const PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION = 1 as const

/** Bounds per family. A workspace above a bound fails the export closed rather than truncating. */
export const PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS = 10_000
export const PORTABLE_WORKSPACE_EXPORT_MAX_MESSAGE_TEXT_LENGTH = 100_000

export const portableExportTreatments = [
  'deferred',
  'excluded',
  'metadata_only',
  'withheld',
] as const
export type PortableExportTreatment = (typeof portableExportTreatments)[number]

export type PortableExportExclusion = Readonly<{
  authority: string
  class: string
  reason: string
  treatment: PortableExportTreatment
}>

/**
 * The exclusion ledger every version-1 document carries verbatim. It names
 * classes, never counts: a count for a withheld class would disclose that
 * private-audience records exist.
 */
export const PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS: readonly PortableExportExclusion[] =
  Object.freeze([
    {
      authority: 'workspace',
      class: 'authority_grants',
      reason:
        'Workspace memberships and roles are authority, not content, and are never exported. The importer becomes the owner of the restored workspace. Project member lists travel as listed but confer no access until a workspace membership exists.',
      treatment: 'excluded',
    },
    {
      authority: 'identity',
      class: 'credentials',
      reason:
        'Sessions, identity bindings, invitation tokens and emails, runtime node signing and command-encryption keys, exchange credentials, challenges and desktop authorization material never leave their authority.',
      treatment: 'excluded',
    },
    {
      authority: 'agent_hq_e2ee_sync (#193)',
      class: 'e2e_ciphertext_replicas',
      reason:
        'Content replica ciphertext and content key envelopes need ContentSyncDevice keys that this export does not carry; synchronized-history portability belongs to #193.',
      treatment: 'excluded',
    },
    {
      authority: 'local_authority',
      class: 'local_authority_bodies',
      reason:
        'Content ref bodies exist only in the local authority. The export carries digest, sensitivity, synchronization policy and body state, never the body.',
      treatment: 'metadata_only',
    },
    {
      authority: 'artifact_store (#86)',
      class: 'artifact_bytes_and_locations',
      reason:
        'Artifact bytes, storage locations, runtime node and external harness references and message or task artifact links wait for Agent HQ object storage promotion (#86).',
      treatment: 'deferred',
    },
    {
      authority: 'remote_content (#189)',
      class: 'remote_content_envelopes',
      reason:
        'RemoteContentEnvelope command and result ciphertext is transient execution transport, not conversation history.',
      treatment: 'excluded',
    },
    {
      authority: 'runtime_node',
      class: 'runtime_execution_state',
      reason:
        'Native sessions, checkpoints, execution and external session references and runtime node bindings are not portable. Only cloud-location execution attempts are recorded.',
      treatment: 'excluded',
    },
    {
      authority: 'agent',
      class: 'agent_private_context',
      reason:
        'Private Agent context, memory and presentation assets are hidden context and are never exported to a conversation participant.',
      treatment: 'excluded',
    },
    {
      authority: 'workspace',
      class: 'derived_and_personal_state',
      reason:
        'Durable event log, delivery state, read state, authorization audit records and lead turn state are derived or personal. Destinations rebuild them; they are not restored.',
      treatment: 'excluded',
    },
    {
      authority: 'workspace (#1221)',
      class: 'job_effect_approval_evidence',
      reason:
        'Job, effect and approval evidence is retained under the retention and cleanup gates owned by #1221 and is not restored by this format version.',
      treatment: 'excluded',
    },
    {
      authority: 'control_plane',
      class: 'control_plane_identifiers',
      reason:
        'Control Plane scope identifiers are external ownership markers. The restored workspace receives its own scope identifiers.',
      treatment: 'excluded',
    },
    {
      authority: 'workspace (#1221)',
      class: 'archived_channels',
      reason:
        'Archived channels are not served by the canonical message readers, so the export does not include them. Their history stays in the product; an archive export belongs to retention (#1221).',
      treatment: 'excluded',
    },
    {
      authority: 'workspace (#1221)',
      class: 'archived_projects',
      reason:
        'Archived projects are not served by the canonical project readers. The export omits them with their channels, tasks and content references, and a project archived during an export denies it. Their history stays in the product; an archive export belongs to retention (#1221).',
      treatment: 'excluded',
    },
    {
      authority: 'workspace (#1221)',
      class: 'soft_deleted_records',
      reason:
        'Soft-deleted projects and records pending retention are not exported. Permanent deletion and retention belong to #1221.',
      treatment: 'excluded',
    },
    {
      authority: 'workspace',
      class: 'audience_withheld',
      reason:
        'Records outside the requester audience (participant-only channels, members-only projects) are omitted and links to them are cleared to null. Counts are not disclosed.',
      treatment: 'withheld',
    },
  ] satisfies PortableExportExclusion[])

export const portableWorkspaceRoles = ['admin', 'member', 'owner'] as const
export type PortableWorkspaceRole = (typeof portableWorkspaceRoles)[number]

export type PortableWorkspace = Readonly<{
  accent: 'amber' | 'blue' | 'cyan' | 'green' | 'pink' | 'violet' | null
  createdAt: string
  logoKind: 'box' | 'emoji' | 'home' | 'monogram'
  logoValue: string | null
  name: string
  scene: 'home' | 'work'
  updatedAt: string
  version: number
  workspaceId: string
}>

/** A user referenced by an exported record. Identity is the ID; no contact or auth fields travel. */
export type PortableUser = Readonly<{ displayName: string | null; userId: string }>

export type PortableProjectMember = Readonly<{ role: 'editor' | 'viewer'; userId: string }>

export type PortableProject = Readonly<{
  createdAt: string
  iconKey: string
  lifecycleState: 'active' | 'archived'
  members: readonly PortableProjectMember[]
  name: string
  projectId: string
  sortOrder: number
  sourceKind: 'none' | 'repository'
  updatedAt: string
  visibility: 'members' | 'workspace'
}>

/** An Agent's identity and profile pin. Presentation assets, runtime bindings and private context are excluded. */
export type PortableAgent = Readonly<{
  agentId: string
  createdAt: string
  isWorkspaceLead: boolean
  lifecycleState: 'active' | 'archived' | 'configuration_error'
  name: string
  profileId: string
  profileRevision: number
  profileState: 'available' | 'deprecated' | 'missing'
  profileVersion: string
  projectId: string | null
  revision: number
  roleSummary: string | null
  updatedAt: string
}>

export type PortableParticipant =
  | Readonly<{ kind: 'user'; userId: string }>
  | Readonly<{ agentId: string; kind: 'agent' }>

export type PortableChannel = Readonly<{
  agentId: string | null
  channelId: string
  createdAt: string
  isPrimaryProjectChannel: boolean
  kind: 'direct_agent' | 'group' | 'project'
  lifecycleState: 'active' | 'archived'
  participants: readonly PortableParticipant[]
  projectId: string | null
  sortOrder: number
  taskId: string | null
  title: string
  updatedAt: string
  version: number
  visibility: 'participants' | 'workspace'
}>

export type PortableMessageSender =
  | Readonly<{ kind: 'user'; userId: string }>
  | Readonly<{ agentId: string; kind: 'agent' }>
  | Readonly<{ kind: 'system'; systemId: string }>

/**
 * A message body. `text` is product-database plaintext, as it is stored in the
 * source. `content_ref` names a body that lives in the local authority and is
 * never in the document. `deleted` is a tombstone and carries no body at all.
 */
export type PortableMessageBody =
  | Readonly<{ kind: 'content_ref'; contentRefId: string }>
  | Readonly<{ kind: 'deleted' }>
  | Readonly<{ kind: 'text'; text: string }>

export type PortableMessage = Readonly<{
  body: PortableMessageBody
  channelId: string
  createdAt: string
  deletedAt: string | null
  editedAt: string | null
  mentions: readonly PortableParticipant[]
  messageId: string
  replyToMessageId: string | null
  sender: PortableMessageSender
  taskId: string | null
  threadRootMessageId: string | null
  updatedAt: string
  version: number
}>

/**
 * A content ref's metadata. `bodyState` is `local_authority` while the body
 * exists in the source's local authority (it is never in the document) and
 * `deleted` once the body has been removed. Availability is device-local state
 * and does not travel: a destination always starts without the body.
 */
export type PortableContentRef = Readonly<{
  bodyState: 'deleted' | 'local_authority'
  contentRefId: string
  contentType: 'message_body' | 'private_field' | 'task_input' | 'task_objective'
  createdAt: string
  digestSha256: string
  keyVersion: number
  messageId: string | null
  revision: number
  schemaVersion: number
  sensitivity: 'restricted' | 'sensitive'
  storagePolicy: 'local_authority'
  synchronizationPolicy: 'agent_hq_e2ee_sync' | 'e2e_optional' | 'local_only'
  taskId: string | null
  updatedAt: string
}>

export type PortableTask = Readonly<{
  agentId: string | null
  channelId: string | null
  createdAt: string
  creatorUserId: string
  kind: 'bug' | 'chore' | 'feature'
  lifecycleState:
    | 'archived'
    | 'cancelled'
    | 'completed'
    | 'created'
    | 'in_progress'
    | 'in_review'
    | 'queued'
  messageId: string | null
  objective: string | null
  objectiveContentRefId: string | null
  priority: 'high' | 'low' | 'normal' | 'urgent'
  projectId: string | null
  taskId: string
  threadRootMessageId: string | null
  title: string
  updatedAt: string
  version: number
}>

export type PortableTaskDependency = Readonly<{ dependsOnTaskId: string; taskId: string }>

/** A cloud-location execution attempt. Runtime-location attempts are excluded (see the ledger). */
export type PortableExecutionAttempt = Readonly<{
  attempt: number
  change: 'authorized_reroute' | 'initial' | 'sticky_retry'
  createdAt: string
  locationKind: 'agent_hq_cloud'
  taskId: string
}>

export type PortableWorkspaceExportContent = Readonly<{
  agents: readonly PortableAgent[]
  channels: readonly PortableChannel[]
  contentRefs: readonly PortableContentRef[]
  executionAttempts: readonly PortableExecutionAttempt[]
  messages: readonly PortableMessage[]
  projects: readonly PortableProject[]
  taskDependencies: readonly PortableTaskDependency[]
  tasks: readonly PortableTask[]
  users: readonly PortableUser[]
  workspace: PortableWorkspace
}>

/**
 * A version-1 document. `contentDigest` is the SHA-256 of the canonical JSON of
 * `content` (see `canonicalPortableJson`); the database layer computes and
 * checks it because this module carries no crypto. Envelope fields (`exportedAt`,
 * `exportedBy`) are not part of the digest, so the same content exported twice
 * has the same digest.
 */
export type PortableWorkspaceExport = Readonly<{
  content: PortableWorkspaceExportContent
  contentDigest: Readonly<{ algorithm: 'sha256'; value: string }>
  exclusions: readonly PortableExportExclusion[]
  exportedAt: string
  exportedBy: Readonly<{ role: PortableWorkspaceRole; userId: string }>
  format: typeof PORTABLE_WORKSPACE_EXPORT_FORMAT
  formatVersion: typeof PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION
}>

export type PortableWorkspaceExportIssueCode =
  | 'closure'
  | 'digest'
  | 'duplicate'
  | 'exclusions'
  | 'format'
  | 'invariant'
  | 'limit'
  | 'missing_field'
  | 'shape'
  | 'unknown_field'
  | 'value'

/** Issues name a path and a rule. They never echo a bundle value, so an error cannot leak content. */
export type PortableWorkspaceExportIssue = Readonly<{
  code: PortableWorkspaceExportIssueCode
  message: string
  path: string
}>

export type PortableWorkspaceExportValidation =
  | Readonly<{ document: PortableWorkspaceExport; ok: true }>
  | Readonly<{ issues: readonly PortableWorkspaceExportIssue[]; ok: false }>

type FieldSpec =
  | Readonly<{ kind: 'bool' }>
  | Readonly<{ kind: 'enum'; nullable?: true; values: readonly string[] }>
  | Readonly<{ kind: 'int'; min: number }>
  | Readonly<{ kind: 'list'; item: FieldSpec; max: number }>
  | Readonly<{ kind: 'literal'; value: number | string }>
  | Readonly<{ kind: 'object'; fields: RecordSpec }>
  | Readonly<{ kind: 'sha256' }>
  | Readonly<{ kind: 'text'; max: number; nonEmpty?: true; nullable?: true }>
  | Readonly<{ kind: 'timestamp'; nullable?: true }>
  | Readonly<{ kind: 'uuid'; nullable?: true }>
  | Readonly<{ kind: 'variant'; tag: string; variants: Readonly<Record<string, RecordSpec>> }>

type RecordSpec = Readonly<Record<string, FieldSpec>>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const TEXT_MAX = 500
const MAX_LIST = PORTABLE_WORKSPACE_EXPORT_MAX_RECORDS

const uuid = { kind: 'uuid' } as const
const nullableUuid = { kind: 'uuid', nullable: true } as const
const timestamp = { kind: 'timestamp' } as const
const nullableTimestamp = { kind: 'timestamp', nullable: true } as const
const name = { kind: 'text', max: TEXT_MAX, nonEmpty: true } as const
const nullableText = { kind: 'text', max: TEXT_MAX, nullable: true } as const
const count = { kind: 'int', min: 1 } as const
const nonNegative = { kind: 'int', min: 0 } as const
const sha256 = { kind: 'sha256' } as const

const participantSpec = {
  kind: 'variant',
  tag: 'kind',
  variants: {
    agent: { agentId: uuid, kind: { kind: 'literal', value: 'agent' } },
    user: { kind: { kind: 'literal', value: 'user' }, userId: uuid },
  },
} as const satisfies FieldSpec

const messageSenderSpec = {
  kind: 'variant',
  tag: 'kind',
  variants: {
    agent: { agentId: uuid, kind: { kind: 'literal', value: 'agent' } },
    system: {
      kind: { kind: 'literal', value: 'system' },
      systemId: { kind: 'text', max: 200, nonEmpty: true },
    },
    user: { kind: { kind: 'literal', value: 'user' }, userId: uuid },
  },
} as const satisfies FieldSpec

const messageBodySpec = {
  kind: 'variant',
  tag: 'kind',
  variants: {
    content_ref: { contentRefId: uuid, kind: { kind: 'literal', value: 'content_ref' } },
    deleted: { kind: { kind: 'literal', value: 'deleted' } },
    text: {
      kind: { kind: 'literal', value: 'text' },
      text: {
        kind: 'text',
        max: PORTABLE_WORKSPACE_EXPORT_MAX_MESSAGE_TEXT_LENGTH,
        nonEmpty: true,
      },
    },
  },
} as const satisfies FieldSpec

const recordSpecs = {
  agents: {
    agentId: uuid,
    createdAt: timestamp,
    isWorkspaceLead: { kind: 'bool' },
    lifecycleState: {
      kind: 'enum',
      values: ['active', 'archived', 'configuration_error'],
    },
    name,
    profileId: { kind: 'text', max: 200, nonEmpty: true },
    profileRevision: nonNegative,
    profileState: { kind: 'enum', values: ['available', 'deprecated', 'missing'] },
    profileVersion: { kind: 'text', max: 200, nonEmpty: true },
    projectId: nullableUuid,
    revision: nonNegative,
    roleSummary: { kind: 'text', max: 2000, nullable: true },
    updatedAt: timestamp,
  },
  channels: {
    agentId: nullableUuid,
    channelId: uuid,
    createdAt: timestamp,
    isPrimaryProjectChannel: { kind: 'bool' },
    kind: { kind: 'enum', values: ['direct_agent', 'group', 'project'] },
    lifecycleState: { kind: 'enum', values: ['active', 'archived'] },
    participants: { kind: 'list', item: participantSpec, max: MAX_LIST },
    projectId: nullableUuid,
    sortOrder: nonNegative,
    taskId: nullableUuid,
    title: name,
    updatedAt: timestamp,
    version: count,
    visibility: { kind: 'enum', values: ['participants', 'workspace'] },
  },
  contentRefs: {
    bodyState: { kind: 'enum', values: ['deleted', 'local_authority'] },
    contentRefId: uuid,
    contentType: {
      kind: 'enum',
      values: ['message_body', 'private_field', 'task_input', 'task_objective'],
    },
    createdAt: timestamp,
    digestSha256: sha256,
    keyVersion: count,
    messageId: nullableUuid,
    revision: count,
    schemaVersion: count,
    sensitivity: { kind: 'enum', values: ['restricted', 'sensitive'] },
    storagePolicy: { kind: 'literal', value: 'local_authority' },
    synchronizationPolicy: {
      kind: 'enum',
      values: ['agent_hq_e2ee_sync', 'e2e_optional', 'local_only'],
    },
    taskId: nullableUuid,
    updatedAt: timestamp,
  },
  executionAttempts: {
    attempt: count,
    change: { kind: 'enum', values: ['authorized_reroute', 'initial', 'sticky_retry'] },
    createdAt: timestamp,
    locationKind: { kind: 'literal', value: 'agent_hq_cloud' },
    taskId: uuid,
  },
  messages: {
    body: messageBodySpec,
    channelId: uuid,
    createdAt: timestamp,
    deletedAt: nullableTimestamp,
    editedAt: nullableTimestamp,
    mentions: { kind: 'list', item: participantSpec, max: 1000 },
    messageId: uuid,
    replyToMessageId: nullableUuid,
    sender: messageSenderSpec,
    taskId: nullableUuid,
    threadRootMessageId: nullableUuid,
    updatedAt: timestamp,
    version: count,
  },
  projects: {
    createdAt: timestamp,
    iconKey: { kind: 'text', max: 200, nonEmpty: true },
    lifecycleState: { kind: 'enum', values: ['active', 'archived'] },
    members: {
      kind: 'list',
      item: {
        kind: 'object',
        fields: { role: { kind: 'enum', values: ['editor', 'viewer'] }, userId: uuid },
      },
      max: MAX_LIST,
    },
    name,
    projectId: uuid,
    sortOrder: nonNegative,
    sourceKind: { kind: 'enum', values: ['none', 'repository'] },
    updatedAt: timestamp,
    visibility: { kind: 'enum', values: ['members', 'workspace'] },
  },
  tasks: {
    agentId: nullableUuid,
    channelId: nullableUuid,
    createdAt: timestamp,
    creatorUserId: uuid,
    kind: { kind: 'enum', values: ['bug', 'chore', 'feature'] },
    lifecycleState: {
      kind: 'enum',
      values: [
        'archived',
        'cancelled',
        'completed',
        'created',
        'in_progress',
        'in_review',
        'queued',
      ],
    },
    messageId: nullableUuid,
    objective: {
      kind: 'text',
      max: PORTABLE_WORKSPACE_EXPORT_MAX_MESSAGE_TEXT_LENGTH,
      nullable: true,
    },
    objectiveContentRefId: nullableUuid,
    priority: { kind: 'enum', values: ['high', 'low', 'normal', 'urgent'] },
    projectId: nullableUuid,
    taskId: uuid,
    threadRootMessageId: nullableUuid,
    title: name,
    updatedAt: timestamp,
    version: count,
  },
  taskDependencies: { dependsOnTaskId: uuid, taskId: uuid },
  users: { displayName: nullableText, userId: uuid },
} as const satisfies Readonly<Record<string, RecordSpec>>

const workspaceSpec = {
  accent: {
    kind: 'enum',
    nullable: true,
    values: ['amber', 'blue', 'cyan', 'green', 'pink', 'violet'],
  },
  createdAt: timestamp,
  logoKind: { kind: 'enum', values: ['box', 'emoji', 'home', 'monogram'] },
  logoValue: { kind: 'text', max: 16, nullable: true },
  name,
  scene: { kind: 'enum', values: ['home', 'work'] },
  updatedAt: timestamp,
  version: count,
  workspaceId: uuid,
} as const satisfies RecordSpec

const familySpec = (item: RecordSpec) =>
  ({ kind: 'list', item: { kind: 'object', fields: item }, max: MAX_LIST }) as const

const contentSpec = {
  agents: familySpec(recordSpecs.agents),
  channels: familySpec(recordSpecs.channels),
  contentRefs: familySpec(recordSpecs.contentRefs),
  executionAttempts: familySpec(recordSpecs.executionAttempts),
  messages: familySpec(recordSpecs.messages),
  projects: familySpec(recordSpecs.projects),
  taskDependencies: familySpec(recordSpecs.taskDependencies),
  tasks: familySpec(recordSpecs.tasks),
  users: familySpec(recordSpecs.users),
  workspace: { kind: 'object', fields: workspaceSpec },
} as const satisfies RecordSpec

const documentSpec = {
  content: { kind: 'object', fields: contentSpec },
  contentDigest: {
    kind: 'object',
    fields: { algorithm: { kind: 'literal', value: 'sha256' }, value: sha256 },
  },
  exclusions: {
    kind: 'list',
    item: {
      kind: 'object',
      fields: {
        authority: name,
        class: name,
        reason: { kind: 'text', max: 1000, nonEmpty: true },
        treatment: { kind: 'enum', values: portableExportTreatments },
      },
    },
    max: 100,
  },
  exportedAt: timestamp,
  exportedBy: {
    kind: 'object',
    fields: { role: { kind: 'enum', values: portableWorkspaceRoles }, userId: uuid },
  },
  format: { kind: 'literal', value: PORTABLE_WORKSPACE_EXPORT_FORMAT },
  formatVersion: { kind: 'literal', value: PORTABLE_WORKSPACE_EXPORT_FORMAT_VERSION },
} as const satisfies RecordSpec

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isIsoTimestamp = (value: string) =>
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

class IssueSink {
  readonly issues: PortableWorkspaceExportIssue[] = []

  add(code: PortableWorkspaceExportIssueCode, path: string, message: string) {
    this.issues.push(Object.freeze({ code, message, path }))
  }
}

function checkField(spec: FieldSpec, value: unknown, path: string, sink: IssueSink): void {
  if (value === null) {
    if ('nullable' in spec && spec.nullable) return
    sink.add('shape', path, 'must not be null')
    return
  }
  switch (spec.kind) {
    case 'bool':
      if (typeof value !== 'boolean') sink.add('shape', path, 'must be a boolean')
      return
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value))
        sink.add('value', path, 'is not an allowed value')
      return
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < spec.min)
        sink.add('value', path, `must be an integer of at least ${spec.min}`)
      return
    case 'literal':
      if (value !== spec.value) sink.add('value', path, 'is not the required literal')
      return
    case 'sha256':
      if (typeof value !== 'string' || !SHA256_PATTERN.test(value))
        sink.add('value', path, 'must be a lowercase sha256 hex digest')
      return
    case 'text':
      if (typeof value !== 'string') {
        sink.add('shape', path, 'must be a string')
        return
      }
      if (value.length > spec.max) sink.add('limit', path, `exceeds ${spec.max} characters`)
      if (spec.nonEmpty && value.trim().length === 0) sink.add('value', path, 'must not be blank')
      return
    case 'timestamp':
      if (typeof value !== 'string' || !isIsoTimestamp(value))
        sink.add('value', path, 'must be a canonical ISO-8601 timestamp')
      return
    case 'uuid':
      if (typeof value !== 'string' || !UUID_PATTERN.test(value))
        sink.add('value', path, 'must be a lowercase UUID')
      return
    case 'list': {
      if (!Array.isArray(value)) {
        sink.add('shape', path, 'must be an array')
        return
      }
      if (value.length > spec.max) sink.add('limit', path, `exceeds ${spec.max} records`)
      value.slice(0, spec.max).forEach((item, index) => {
        checkField(spec.item, item, `${path}[${index}]`, sink)
      })
      return
    }
    case 'object':
      checkRecord(spec.fields, value, path, sink)
      return
    case 'variant': {
      if (!isPlainObject(value)) {
        sink.add('shape', path, 'must be an object')
        return
      }
      const tag = value[spec.tag]
      const variant = typeof tag === 'string' ? spec.variants[tag] : undefined
      if (!variant) {
        sink.add('value', `${path}.${spec.tag}`, 'is not an allowed variant')
        return
      }
      checkRecord(variant, value, path, sink)
      return
    }
  }
}

function checkRecord(spec: RecordSpec, value: unknown, path: string, sink: IssueSink): void {
  if (!isPlainObject(value)) {
    sink.add('shape', path, 'must be an object')
    return
  }
  for (const key of Object.keys(spec)) {
    if (!(key in value)) {
      sink.add('missing_field', `${path}.${key}`, 'is required')
      continue
    }
    checkField(spec[key]!, value[key], `${path}.${key}`, sink)
  }
  for (const key of Object.keys(value)) {
    if (!(key in spec))
      sink.add('unknown_field', `${path}.${key}`, 'is not part of format version 1')
  }
}

type Records = readonly Record<string, unknown>[]

function recordsOf(value: unknown): Records {
  return Array.isArray(value) ? (value as Records) : []
}

function uniqueIds(
  records: Records,
  key: string,
  family: string,
  sink: IssueSink,
  compositeKey?: (record: Record<string, unknown>) => string
) {
  const seen = new Set<string>()
  records.forEach((record, index) => {
    const id = compositeKey ? compositeKey(record) : String(record[key])
    if (seen.has(id)) sink.add('duplicate', `content.${family}[${index}].${key}`, 'is repeated')
    seen.add(id)
  })
  return seen
}

/**
 * Referential closure and cross-field invariants the field descriptors cannot
 * express. A document that passes is restorable: every reference resolves
 * inside the document, so an import never has to guess or create a record.
 */
function checkContent(content: Record<string, unknown>, sink: IssueSink): void {
  const users = recordsOf(content.users)
  const agents = recordsOf(content.agents)
  const projects = recordsOf(content.projects)
  const channels = recordsOf(content.channels)
  const messages = recordsOf(content.messages)
  const tasks = recordsOf(content.tasks)
  const contentRefs = recordsOf(content.contentRefs)

  const userIds = uniqueIds(users, 'userId', 'users', sink)
  const agentIds = uniqueIds(agents, 'agentId', 'agents', sink)
  const projectIds = uniqueIds(projects, 'projectId', 'projects', sink)
  const channelIds = uniqueIds(channels, 'channelId', 'channels', sink)
  const messageIds = uniqueIds(messages, 'messageId', 'messages', sink)
  const taskIds = uniqueIds(tasks, 'taskId', 'tasks', sink)
  const contentRefIds = uniqueIds(contentRefs, 'contentRefId', 'contentRefs', sink)
  const messageChannel = new Map<string, string>(
    messages.map((message) => [String(message.messageId), String(message.channelId)] as const)
  )

  const requireRef = (ids: Set<string>, id: unknown, path: string, label: string) => {
    if (typeof id === 'string' && !ids.has(id))
      sink.add('closure', path, `does not resolve to an exported ${label}`)
  }
  const requireParticipant = (participant: Record<string, unknown>, path: string) => {
    if (participant.kind === 'user')
      requireRef(userIds, participant.userId, `${path}.userId`, 'user')
    else requireRef(agentIds, participant.agentId, `${path}.agentId`, 'agent')
  }

  for (const [index, project] of projects.entries()) {
    const base = `content.projects[${index}]`
    uniqueIds(recordsOf(project.members), 'userId', `projects[${index}].members`, sink)
    for (const [memberIndex, member] of recordsOf(project.members).entries())
      requireRef(userIds, member.userId, `${base}.members[${memberIndex}].userId`, 'user')
  }

  for (const [index, agent] of agents.entries()) {
    const base = `content.agents[${index}]`
    requireRef(projectIds, agent.projectId, `${base}.projectId`, 'project')
    if (
      agent.isWorkspaceLead === true &&
      (agent.projectId !== null || agent.lifecycleState === 'archived')
    )
      sink.add('invariant', base, 'the workspace lead is standalone and never archived')
  }

  for (const [index, channel] of channels.entries()) {
    const base = `content.channels[${index}]`
    requireRef(projectIds, channel.projectId, `${base}.projectId`, 'project')
    requireRef(agentIds, channel.agentId, `${base}.agentId`, 'agent')
    requireRef(taskIds, channel.taskId, `${base}.taskId`, 'task')
    const kindMatches =
      channel.kind === 'project'
        ? channel.projectId !== null && channel.agentId === null
        : channel.kind === 'direct_agent'
          ? channel.projectId === null && channel.agentId !== null
          : true
    if (!kindMatches) sink.add('invariant', base, 'channel kind does not match its links')
    if (channel.isPrimaryProjectChannel === true && channel.kind !== 'project')
      sink.add('invariant', base, 'only project channels are primary')
    const participants = recordsOf(channel.participants)
    const keys = participants.map((participant) => JSON.stringify(participant))
    if (new Set(keys).size !== keys.length)
      sink.add('duplicate', `${base}.participants`, 'is repeated')
    for (const [pIndex, participant] of participants.entries())
      requireParticipant(participant, `${base}.participants[${pIndex}]`)
  }

  for (const [index, message] of messages.entries()) {
    const base = `content.messages[${index}]`
    requireRef(channelIds, message.channelId, `${base}.channelId`, 'channel')
    requireRef(taskIds, message.taskId, `${base}.taskId`, 'task')
    const sender = message.sender as Record<string, unknown>
    if (sender.kind === 'user') requireRef(userIds, sender.userId, `${base}.sender.userId`, 'user')
    if (sender.kind === 'agent')
      requireRef(agentIds, sender.agentId, `${base}.sender.agentId`, 'agent')
    for (const [mIndex, mention] of recordsOf(message.mentions).entries())
      requireParticipant(mention, `${base}.mentions[${mIndex}]`)
    const body = message.body as Record<string, unknown>
    if (body.kind === 'content_ref')
      requireRef(contentRefIds, body.contentRefId, `${base}.body.contentRefId`, 'content ref')
    const deleted = body.kind === 'deleted'
    if (deleted !== (message.deletedAt !== null))
      sink.add(
        'invariant',
        base,
        'a deleted message carries no body and a body carries no deletion'
      )
    for (const link of ['threadRootMessageId', 'replyToMessageId'] as const) {
      const target = message[link]
      if (target === null || target === undefined) continue
      requireRef(messageIds, target, `${base}.${link}`, 'message')
      if (typeof target === 'string' && messageChannel.get(target) !== message.channelId)
        sink.add('invariant', `${base}.${link}`, 'must reference a message in the same channel')
    }
  }

  for (const [index, ref] of contentRefs.entries()) {
    const base = `content.contentRefs[${index}]`
    requireRef(taskIds, ref.taskId, `${base}.taskId`, 'task')
    requireRef(messageIds, ref.messageId, `${base}.messageId`, 'message')
    if (ref.contentType === 'message_body' && ref.taskId !== null)
      sink.add('invariant', base, 'a message body is attached to a message, not a task')
    if (
      (ref.contentType === 'task_objective' || ref.contentType === 'task_input') &&
      ref.messageId !== null
    )
      sink.add('invariant', base, 'a task objective or input is attached to a task, not a message')
  }

  for (const [index, task] of tasks.entries()) {
    const base = `content.tasks[${index}]`
    requireRef(userIds, task.creatorUserId, `${base}.creatorUserId`, 'user')
    requireRef(agentIds, task.agentId, `${base}.agentId`, 'agent')
    requireRef(projectIds, task.projectId, `${base}.projectId`, 'project')
    requireRef(channelIds, task.channelId, `${base}.channelId`, 'channel')
    requireRef(messageIds, task.messageId, `${base}.messageId`, 'message')
    requireRef(messageIds, task.threadRootMessageId, `${base}.threadRootMessageId`, 'message')
    requireRef(
      contentRefIds,
      task.objectiveContentRefId,
      `${base}.objectiveContentRefId`,
      'content ref'
    )
    if ((task.objective === null) === (task.objectiveContentRefId === null))
      sink.add('invariant', base, 'exactly one of objective or objectiveContentRefId is present')
  }

  const dependencyKeys = new Set<string>()
  for (const [index, dependency] of recordsOf(content.taskDependencies).entries()) {
    const base = `content.taskDependencies[${index}]`
    requireRef(taskIds, dependency.taskId, `${base}.taskId`, 'task')
    requireRef(taskIds, dependency.dependsOnTaskId, `${base}.dependsOnTaskId`, 'task')
    if (dependency.taskId === dependency.dependsOnTaskId)
      sink.add('invariant', base, 'a task cannot depend on itself')
    const key = `${String(dependency.taskId)}>${String(dependency.dependsOnTaskId)}`
    if (dependencyKeys.has(key)) sink.add('duplicate', base, 'is repeated')
    dependencyKeys.add(key)
  }

  uniqueIds(
    recordsOf(content.executionAttempts),
    'attempt',
    'executionAttempts',
    sink,
    (record) => `${String(record.taskId)}#${String(record.attempt)}`
  )
  for (const [index, attempt] of recordsOf(content.executionAttempts).entries())
    requireRef(taskIds, attempt.taskId, `content.executionAttempts[${index}].taskId`, 'task')
}

/**
 * Validate an untrusted value as a version-1 portable export. Pure and total:
 * it never throws, and every problem is reported as an issue with a path.
 * Validation proves structure, closure and invariants. It does not check the
 * content digest (the database layer does) and it does not check audience.
 */
export function validatePortableWorkspaceExport(value: unknown): PortableWorkspaceExportValidation {
  const sink = new IssueSink()
  checkRecord(documentSpec, value, 'document', sink)
  if (sink.issues.length === 0 && isPlainObject(value)) {
    if (
      canonicalPortableJson(value.exclusions) !==
      canonicalPortableJson(PORTABLE_WORKSPACE_EXPORT_EXCLUSIONS)
    )
      sink.add(
        'exclusions',
        'document.exclusions',
        'must carry the version-1 exclusion ledger verbatim'
      )
    checkContent(value.content as Record<string, unknown>, sink)
  }
  if (sink.issues.length > 0) return { issues: Object.freeze(sink.issues), ok: false }
  return { document: value as PortableWorkspaceExport, ok: true }
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (!isPlainObject(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).toSorted()) sorted[key] = sortedKeys(value[key])
  return sorted
}

/**
 * The canonical JSON of a value: object keys sorted by code unit, no
 * insignificant whitespace, array order preserved. The content digest is the
 * SHA-256 of this string for `PortableWorkspaceExportContent`.
 */
export function canonicalPortableJson(value: unknown): string {
  return JSON.stringify(sortedKeys(value))
}
