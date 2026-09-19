import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  ArchiveRecord,
  DevCommand,
  DevError,
  DevOperation,
  Group,
  DevRuntimePage,
  Project,
  RuntimeSession,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
import { devOperationDecoders } from '../../../../../../packages/types/src/dev-runtime'
import type { ChannelAuthority } from '../channel/authority'
import { DevAuthorityError } from '../authority'
import { createDurableJsonStore } from '../host-store'

export type ProjectSessionRuntime = Readonly<{
  providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>>
  upsertGroup(group: Group): void
  upsertProject(project: Project): void
  upsertSession(session: RuntimeSession): void
  /** Read-only resolution for sibling slices (e.g. the harness substrate);
   * it grants no authority — every gated operation re-checks its own
   * scope/resource/generation bindings after resolving the record. */
  getSession(runtimeSessionId: string): RuntimeSession | undefined
  /** Test/ops introspection: the durable archive journal, oldest first. */
  archiveRecords(): readonly ArchiveRecord[]
}>

/**
 * The canonical project/runtime-session authority shared by Dev View and Chat.
 *
 * One snapshot record commits groups, projects, sessions, and the archive
 * journal together, so `dev.session.archive`/`dev.session.unarchive` persist
 * the session flip and its `ArchiveRecord` in a single atomic file write
 * (fsync + rename + directory fsync) — a crash can never leave an archived
 * session without its durable record. The legacy `projection.json` written by
 * the earlier local projection is seeded once and never deleted; it was never
 * an authority, but its records are user data and are migrated losslessly.
 *
 * Every mutation enforces the scope triple (a foreign scope is
 * `unauthorized`, never a silent drop), the ownership epoch
 * (`stale_generation` for a lower generation), and optimistic concurrency
 * (`stale_version` for a non-advancing version). Reads fail closed on a stored
 * record that no longer decodes (`corrupt_state`); unknown state is never
 * coerced into success.
 */

type AuthorityRecord = Readonly<{
  scope: Scope
  groups: Group[]
  projects: Project[]
  sessions: RuntimeSession[]
  archiveRecords: ArchiveRecord[]
}>

const AUTHORITY_STORE_FILE = join('dev-runtime', 'project-session', 'authority.json')
const LEGACY_PROJECTION_FILE = join('dev-runtime', 'project-session', 'projection.json')
const AUTHORITY_SCHEMA_VERSION = 1

const PROJECT_STATES: ReadonlySet<string> = new Set([
  'importing',
  'cloning',
  'scanning',
  'ready',
  'archived',
  'failed',
])
const SESSION_STATES: ReadonlySet<string> = new Set([
  'preparing',
  'ready',
  'active',
  'disconnected',
  'completed',
  'failed',
  'cancelled',
])
const ARCHIVE_STATES: ReadonlySet<string> = new Set(['archived', 'restoring', 'restored'])
const SESSION_PROJECTIONS: ReadonlySet<string> = new Set([
  'structured',
  'authenticated_hook',
  'terminal_fallback',
])

function isScope(value: unknown): value is Scope {
  const record = value as Scope | undefined
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.accountId === 'string' &&
    typeof record.workspaceId === 'string' &&
    typeof record.runtimeNodeId === 'string'
  )
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

const corruptRecord = () =>
  new DevAuthorityError('corrupt_state', 'authority store record failed to decode')

/** Structural decode of a stored record; anything else is `corrupt_state`. */
function validateStoredRecord(record: AuthorityRecord): void {
  const fail = corruptRecord
  if (!isScope(record.scope)) throw fail()
  if (!Array.isArray(record.groups) || !Array.isArray(record.projects)) throw fail()
  if (!Array.isArray(record.sessions) || !Array.isArray(record.archiveRecords)) throw fail()
  const scope = record.scope
  const inScope = (candidate: unknown) =>
    isScope(candidate) && JSON.stringify(candidate) === JSON.stringify(scope)
  const positive = (value: unknown) => isPositiveInteger(value)
  for (const group of record.groups) {
    if (
      typeof group !== 'object' ||
      group === null ||
      typeof group.id !== 'string' ||
      typeof group.name !== 'string' ||
      !Array.isArray(group.projectIds) ||
      group.projectIds.some((id) => typeof id !== 'string') ||
      typeof group.sortKey !== 'string' ||
      !positive(group.version) ||
      !inScope(group.scope)
    )
      throw fail()
  }
  for (const project of record.projects) {
    if (
      typeof project !== 'object' ||
      project === null ||
      typeof project.id !== 'string' ||
      typeof project.name !== 'string' ||
      !Array.isArray(project.repoIds) ||
      project.repoIds.some((id) => typeof id !== 'string') ||
      !Array.isArray(project.groupIds) ||
      project.groupIds.some((id) => typeof id !== 'string') ||
      !PROJECT_STATES.has(project.lifecycle) ||
      !positive(project.version) ||
      !inScope(project.scope)
    )
      throw fail()
  }
  for (const session of record.sessions) {
    if (
      typeof session !== 'object' ||
      session === null ||
      typeof session.id !== 'string' ||
      typeof session.projectId !== 'string' ||
      typeof session.repoId !== 'string' ||
      typeof session.worktreeId !== 'string' ||
      typeof session.archived !== 'boolean' ||
      !SESSION_STATES.has(session.lifecycle) ||
      !SESSION_PROJECTIONS.has(session.projection) ||
      !positive(session.version) ||
      !positive(session.generation) ||
      !inScope(session.scope)
    )
      throw fail()
  }
  for (const archive of record.archiveRecords) {
    if (
      typeof archive !== 'object' ||
      archive === null ||
      typeof archive.id !== 'string' ||
      typeof archive.runtimeSessionId !== 'string' ||
      typeof archive.worktreeId !== 'string' ||
      typeof archive.archivedAt !== 'string' ||
      typeof archive.archivedBy !== 'string' ||
      !ARCHIVE_STATES.has(archive.state) ||
      !positive(archive.generation) ||
      !inScope(archive.scope)
    )
      throw fail()
  }
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

function page<T>(items: readonly T[]): DevRuntimePage<T> {
  return { items: [...items], observedAt: new Date().toISOString() }
}

function requireScope(command: DevCommand, scope: Scope): void {
  if (!sameScope(command.scope, scope))
    throw new DevAuthorityError('unauthorized', 'project/session scope is not authorized')
}

function devError(code: DevError['code'], message: string): DevError {
  return { code, retryable: false, message }
}

/** The envelope resource for runtime_session operations must name this
 * session at its current generation: a stale or foreign binding is refused
 * before the provider touches the record. */
function requireSessionResource(command: DevCommand, session: RuntimeSession): void {
  const resource = command.resource
  if (resource === undefined) {
    throw devError('identity_mismatch', 'operation requires a runtime_session resource binding')
  }
  if (resource.kind !== 'runtime_session') {
    throw devError('identity_mismatch', 'resource kind must be runtime_session')
  }
  if (resource.id !== session.id) {
    throw devError('identity_mismatch', 'resource id does not match the request body')
  }
  if (resource.generation !== session.generation) {
    throw devError('stale_generation', 'resource generation does not match the session record')
  }
}

function archiveRecord(
  session: RuntimeSession,
  scope: Scope,
  state: ArchiveRecord['state'],
  reason?: string
): ArchiveRecord {
  return {
    id: randomUUID(),
    scope,
    runtimeSessionId: session.id,
    worktreeId: session.worktreeId,
    state,
    archivedAt: new Date().toISOString(),
    archivedBy: 'desktop-owner',
    generation: session.generation,
    ...(reason ? { reason } : {}),
    ...(state === 'restored' ? { restoredAt: new Date().toISOString() } : {}),
  }
}

/**
 * Seed from the earlier local projection exactly once. The legacy file is read
 * only when the authority store does not exist yet and is never rewritten or
 * deleted: it was not authoritative, but its records are user data.
 */
function legacySeedRecords(dataDir: string, scope: Scope): AuthorityRecord | undefined {
  const legacyFile = join(dataDir, LEGACY_PROJECTION_FILE)
  if (!existsSync(legacyFile)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(legacyFile, 'utf8'))
  } catch {
    // An unreadable legacy projection is retained untouched on disk; the new
    // store starts empty rather than guessing at its contents.
    return undefined
  }
  const envelope = parsed as { schemaVersion?: unknown; records?: unknown }
  if (envelope.schemaVersion !== 1 || !Array.isArray(envelope.records)) return undefined
  const candidate = envelope.records[0] as AuthorityRecord | undefined
  if (!candidate || !isScope(candidate.scope) || !sameScope(candidate.scope, scope))
    return undefined
  return {
    scope,
    groups: Array.isArray(candidate.groups) ? [...candidate.groups] : [],
    projects: Array.isArray(candidate.projects) ? [...candidate.projects] : [],
    sessions: Array.isArray(candidate.sessions) ? [...candidate.sessions] : [],
    archiveRecords: [],
  }
}

export function registerProjectSessionRuntime(input: {
  authority: ChannelAuthority
  dataDir: string
  scope: Scope
  /** Shell event bus; session changes publish so Chat and Dev share them. */
  publish?: (event: string, payload: unknown) => void
  /** Fail-closed creation hook: the composition proves the worktree exists
   *  and belongs to this scope before a session record is created. */
  validateSessionCreation?: (body: {
    projectId: string
    repoId: string
    worktreeId: string
  }) => void
}): ProjectSessionRuntime {
  const store = createDurableJsonStore<AuthorityRecord>({
    file: join(input.dataDir, AUTHORITY_STORE_FILE),
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    label: 'project/session authority',
  })
  const emptyRecord = (): AuthorityRecord => ({
    scope: input.scope,
    groups: [],
    projects: [],
    sessions: [],
    archiveRecords: [],
  })
  const storeFile = join(input.dataDir, AUTHORITY_STORE_FILE)
  const loaded = existsSync(storeFile)
    ? store.load()
    : { schemaVersion: AUTHORITY_SCHEMA_VERSION, savedAt: '', records: [] as AuthorityRecord[] }
  const seededFromLegacy = !loaded.records[0]
  let record: AuthorityRecord = seededFromLegacy
    ? (legacySeedRecords(input.dataDir, input.scope) ?? emptyRecord())
    : loaded.records[0]!
  validateStoredRecord(record)
  if (!sameScope(record.scope, input.scope))
    throw new DevAuthorityError(
      'corrupt_state',
      'authority store belongs to another account/workspace/runtime node'
    )
  const save = () => store.save([record])
  // A legacy seed commits immediately so the very first restart cannot lose it.
  if (
    seededFromLegacy &&
    (record.groups.length > 0 || record.projects.length > 0 || record.sessions.length > 0)
  )
    save()

  /** Optimistic-concurrency upsert shared by every entity kind. */
  const upsert = <T extends { id: string; scope: Scope; version: number; generation?: number }>(
    list: T[],
    incoming: T
  ): T[] => {
    if (!sameScope(incoming.scope, input.scope))
      throw new DevAuthorityError('unauthorized', 'record scope is not authorized')
    const stored = list.find((entry) => entry.id === incoming.id)
    if (stored) {
      if (incoming.generation !== undefined && incoming.generation < stored.generation!)
        throw new DevAuthorityError(
          'stale_generation',
          `record ${incoming.id} is owned by generation ${stored.generation}`,
          incoming.version
        )
      if (incoming.version <= stored.version)
        throw new DevAuthorityError(
          'stale_version',
          `record ${incoming.id} version ${incoming.version} does not advance ${stored.version}`,
          stored.version
        )
      return list.map((entry) => (entry.id === incoming.id ? incoming : entry))
    }
    return [...list, incoming]
  }

  const findSession = (id: string): RuntimeSession => {
    const session = record.sessions.find((entry) => entry.id === id)
    if (!session) throw new DevAuthorityError('not_found', `runtime session ${id} is unknown`)
    return session
  }

  function publishSession(session: RuntimeSession, kind: string): void {
    input.publish?.('dev.session.updated', {
      kind,
      runtimeSessionId: session.id,
      scope: session.scope,
      generation: session.generation,
      version: session.version,
      archived: session.archived,
      lifecycle: session.lifecycle,
      observedAt: new Date().toISOString(),
    })
  }

  const providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>> = {
    'dev.group.list': (command) => {
      requireScope(command, input.scope)
      return page(record.groups)
    },
    'dev.group.reorder': (command) => {
      requireScope(command, input.scope)
      const body = command.body as { orderedGroupIds: string[] }
      const known = new Map(record.groups.map((group) => [group.id, group]))
      const ordered = body.orderedGroupIds
      if (ordered.some((id) => !known.has(id)))
        throw new DevAuthorityError('not_found', 'group reorder contains an unknown group')
      if (new Set(ordered).size !== ordered.length)
        throw new DevAuthorityError('invalid_state', 'group reorder contains duplicates')
      const moved =
        ordered.length !== record.groups.length ||
        record.groups.some((group, index) => group.id !== ordered[index])
      if (moved) {
        record = {
          ...record,
          groups: ordered.map((id, index) => {
            const group = known.get(id)!
            return {
              ...group,
              sortKey: String(index).padStart(10, '0'),
              version: group.version + 1,
            }
          }),
        }
        save()
      }
      return page(record.groups)
    },
    'dev.project.list': (command) => {
      requireScope(command, input.scope)
      return page(record.projects)
    },
    'dev.project.get': (command) => {
      requireScope(command, input.scope)
      const projectId = (command.body as { projectId: string }).projectId
      const project = record.projects.find((entry) => entry.id === projectId)
      if (!project) throw new DevAuthorityError('not_found', `project ${projectId} is unknown`)
      return project
    },
    'dev.project.reorder': (command) => {
      requireScope(command, input.scope)
      const body = command.body as {
        groupId: string
        orderedProjectIds: string[]
        expectedGroupVersion: number
      }
      const group = record.groups.find((entry) => entry.id === body.groupId)
      if (!group) throw new DevAuthorityError('not_found', `group ${body.groupId} is unknown`)
      if (group.version !== body.expectedGroupVersion)
        throw new DevAuthorityError(
          'stale_version',
          `group ${group.id} moved on: version ${group.version}`,
          group.version
        )
      const known = new Set(group.projectIds)
      if (body.orderedProjectIds.some((id) => !known.has(id)))
        throw new DevAuthorityError('not_found', 'project reorder contains a foreign project')
      const next = { ...group, projectIds: [...body.orderedProjectIds], version: group.version + 1 }
      record = {
        ...record,
        groups: record.groups.map((entry) => (entry.id === group.id ? next : entry)),
      }
      save()
      return next
    },
    'dev.session.create': (command) => {
      requireScope(command, input.scope)
      const body = command.body as {
        projectId: string
        repoId: string
        worktreeId: string
        taskId?: string
        agentProfileId?: string
        agentProfileVersion?: number
        harnessInstallationId?: string
      }
      const project = record.projects.find((entry) => entry.id === body.projectId)
      if (!project) throw new DevAuthorityError('not_found', `project ${body.projectId} is unknown`)
      if (!project.repoIds.includes(body.repoId))
        throw new DevAuthorityError(
          'identity_mismatch',
          `repository ${body.repoId} is not bound to project ${project.id}`
        )
      if (command.resource !== undefined) {
        throw devError('identity_mismatch', 'dev.session.create carries no resource binding')
      }
      // The composition proves the referenced worktree is registered and
      // live on this node before any session record exists.
      input.validateSessionCreation?.({
        projectId: body.projectId,
        repoId: body.repoId,
        worktreeId: body.worktreeId,
      })
      const created: RuntimeSession = {
        id: randomUUID(),
        scope: input.scope,
        projectId: project.id,
        repoId: body.repoId,
        worktreeId: body.worktreeId,
        lifecycle: 'preparing',
        archived: false,
        projection: 'structured',
        generation: 1,
        version: 1,
        ...(body.taskId ? { taskId: body.taskId } : {}),
        ...(body.agentProfileId ? { agentProfileId: body.agentProfileId } : {}),
        ...(body.agentProfileVersion !== undefined
          ? { agentProfileVersion: body.agentProfileVersion }
          : {}),
        ...(body.harnessInstallationId
          ? { harnessInstallationId: body.harnessInstallationId }
          : {}),
      }
      record = { ...record, sessions: [...record.sessions, created] }
      save()
      publishSession(created, 'session.created')
      return created
    },
    'dev.session.list': (command) => {
      requireScope(command, input.scope)
      return page(
        record.sessions.filter((entry) => {
          const body = command.body as {
            runtimeSessionId?: string
            projectId?: string
            archived?: boolean
          }
          return (
            (body.runtimeSessionId === undefined || entry.id === body.runtimeSessionId) &&
            (body.projectId === undefined || entry.projectId === body.projectId) &&
            (body.archived === undefined || entry.archived === body.archived)
          )
        })
      )
    },
    'dev.session.get': (command) => {
      requireScope(command, input.scope)
      return findSession((command.body as { runtimeSessionId: string }).runtimeSessionId)
    },
    'dev.session.archive': (command) => {
      requireScope(command, input.scope)
      const body = command.body as {
        runtimeSessionId: string
        expectedGeneration: number
        reason?: string
      }
      const session = findSession(body.runtimeSessionId)
      if (session.generation !== body.expectedGeneration)
        throw new DevAuthorityError(
          'stale_generation',
          `runtime session ${session.id} is owned by generation ${session.generation}`,
          session.version
        )
      if (session.archived)
        throw new DevAuthorityError(
          'invalid_state',
          `runtime session ${session.id} is already archived`
        )
      const next = { ...session, archived: true, version: session.version + 1 }
      const archived = archiveRecord(next, input.scope, 'archived', body.reason)
      // One atomic write commits the session flip and its durable record.
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
        archiveRecords: [...record.archiveRecords, archived],
      }
      save()
      publishSession(next, 'session.archived')
      return archived
    },
    'dev.session.unarchive': (command) => {
      requireScope(command, input.scope)
      const body = command.body as { runtimeSessionId: string; expectedGeneration: number }
      const session = findSession(body.runtimeSessionId)
      if (session.generation !== body.expectedGeneration)
        throw new DevAuthorityError(
          'stale_generation',
          `runtime session ${session.id} is owned by generation ${session.generation}`,
          session.version
        )
      if (!session.archived)
        throw new DevAuthorityError(
          'invalid_state',
          `runtime session ${session.id} is not archived`
        )
      const next = { ...session, archived: false, version: session.version + 1 }
      const restored = archiveRecord(next, input.scope, 'restored')
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
        archiveRecords: [...record.archiveRecords, restored],
      }
      save()
      publishSession(next, 'session.unarchived')
      return restored
    },
    'dev.session.transferInput': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.session.transferInput'].request(command.body)
      const session = record.sessions.find(
        (entry) => entry.id === (body.runtimeSessionId as string)
      )
      if (!session) throw devError('not_found', 'runtime session not found')
      requireSessionResource(command, session)
      if (session.generation !== (body.expectedGeneration as number)) {
        throw devError('stale_generation', 'runtime session generation conflict')
      }
      if (session.version !== (body.expectedOwnerVersion as number)) {
        throw devError('stale_version', 'input owner version conflict')
      }
      if (session.archived) {
        throw devError('invalid_state', 'an archived session grants no input ownership')
      }
      // Ownership transfer is the one input-authority operation: it bumps
      // the generation, so input granted under the old generation is inert.
      const next: RuntimeSession = {
        ...session,
        generation: session.generation + 1,
        version: session.version + 1,
        lifecycle: session.lifecycle === 'ready' ? 'active' : session.lifecycle,
      }
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
      }
      save()
      publishSession(next, 'session.input_transferred')
      return next
    },
  }
  for (const [operation, provider] of Object.entries(providers)) {
    input.authority.registerCommandProvider(operation as DevOperation, provider)
  }
  return {
    providers,
    upsertGroup(group) {
      record = { ...record, groups: upsert(record.groups, group) }
      save()
    },
    upsertProject(project) {
      record = { ...record, projects: upsert(record.projects, project) }
      save()
    },
    upsertSession(session) {
      record = { ...record, sessions: upsert(record.sessions, session) }
      save()
    },
    getSession(runtimeSessionId) {
      return record.sessions.find((entry) => entry.id === runtimeSessionId)
    },
    archiveRecords: () => [...record.archiveRecords],
  }
}
