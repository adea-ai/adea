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
import { createDurableSqliteStore } from '../host-store'

export type ProjectRepoBindingView = Readonly<{
  repoId: string
  rootBookmarkId: string
  canonicalRoot: string
  projectId: string
}>

export type ProjectSessionRuntime = Readonly<{
  providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>>
  upsertGroup(group: Group): void
  upsertProject(project: Project): void
  upsertSession(session: RuntimeSession): void
  /** Read-only resolution for sibling slices (e.g. the harness substrate);
   * it grants no authority — every gated operation re-checks its own
   * scope/resource/generation bindings after resolving the record. */
  getSession(runtimeSessionId: string): RuntimeSession | undefined
  /** Read-only resolution for the repository registry (#398): the binding
   * triples minted at import, one per project that binds the repo. They name
   * the authorized bookmark and canonical root; they prove nothing at use
   * time — the repo registry re-proves containment and identity through the
   * roots authority itself. */
  findRepoBindings(repoId: string): readonly ProjectRepoBindingView[]
  /** Test/ops introspection: the durable archive journal, oldest first. */
  archiveRecords(): readonly ArchiveRecord[]
}>

/**
 * The canonical project/runtime-session authority shared by Dev View and Chat.
 *
 * One snapshot record commits groups, projects, sessions, and the archive
 * journal together, so `dev.session.archive`/`dev.session.unarchive` persist
 * the session flip and its `ArchiveRecord` in one SQLite transaction. The
 * authority database uses WAL/full sync and retains the legacy JSON envelope
 * as a retryable migration source. The legacy `projection.json` written by
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

const AUTHORITY_STORE_FILE = join('dev-runtime', 'project-session', 'authority.sqlite3')
const LEGACY_AUTHORITY_STORE_FILE = join('dev-runtime', 'project-session', 'authority.json')
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
/** Session states that still reference execution; archive refuses while any
 * session on the project is in one of these and not itself archived. */
const LIVE_SESSION_STATES: ReadonlySet<string> = new Set([
  'preparing',
  'ready',
  'active',
  'disconnected',
])
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

/** Group operations carry a group resource binding (no generation: groups
 * fence through their optimistic version alone). */
function requireGroupResource(command: DevCommand, groupId: string): void {
  const resource = command.resource
  if (resource === undefined) {
    throw devError('identity_mismatch', 'operation requires a group resource binding')
  }
  if (resource.kind !== 'group') {
    throw devError('identity_mismatch', 'resource kind must be group')
  }
  if (resource.id !== groupId) {
    throw devError('identity_mismatch', 'resource id does not match the request body')
  }
}

/** Project operations carry a project resource binding. Projects fence
 * through their optimistic version alone, so the envelope's numeric
 * generation must equal that version (spec: a record without a `generation`
 * field binds its resource generation to its `version`). */
function requireProjectResource(command: DevCommand, projectId: string): void {
  const resource = command.resource
  if (resource === undefined) {
    throw devError('identity_mismatch', 'operation requires a project resource binding')
  }
  if (resource.kind !== 'project') {
    throw devError('identity_mismatch', 'resource kind must be project')
  }
  if (resource.id !== projectId) {
    throw devError('identity_mismatch', 'resource id does not match the request body')
  }
}

/** The register's display order is the record-array order; sortKeys are the
 * padded positions assigned on every ordering decision. */
const sortKeyFor = (index: number): string => String(index).padStart(10, '0')

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
  /**
   * Fail-closed import hook (#398): the composition resolves an authorized
   * root bookmark through the roots authority and returns its canonical
   * root. Any refusal (unknown, revoked, drifted, replaced) throws before
   * the register touches the record; client-supplied paths never reach it.
   */
  resolveImportRoot?: (rootBookmarkId: string) => { canonicalRoot: string }
}): ProjectSessionRuntime {
  const store = createDurableSqliteStore<AuthorityRecord>({
    file: join(input.dataDir, AUTHORITY_STORE_FILE),
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    label: 'project/session authority',
    legacyFile: join(input.dataDir, LEGACY_AUTHORITY_STORE_FILE),
    scope: input.scope,
  })
  const emptyRecord = (): AuthorityRecord => ({
    scope: input.scope,
    groups: [],
    projects: [],
    sessions: [],
    archiveRecords: [],
  })
  const loaded = store.load()
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

  function publishProject(project: Project, kind: string): void {
    input.publish?.('dev.project.updated', {
      kind,
      projectId: project.id,
      scope: project.scope,
      version: project.version,
      lifecycle: project.lifecycle,
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
              sortKey: sortKeyFor(index),
              version: group.version + 1,
            }
          }),
        }
        save()
      }
      return page(record.groups)
    },
    'dev.group.create': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.group.create'].request(command.body)
      const name = body.name as string
      const colorToken = body.colorToken as string | undefined
      const afterGroupId = body.afterGroupId as string | undefined
      if (afterGroupId !== undefined && !record.groups.some((group) => group.id === afterGroupId))
        throw new DevAuthorityError('not_found', `group ${afterGroupId} is unknown`)
      const created: Group = {
        id: randomUUID(),
        scope: input.scope,
        name,
        projectIds: [],
        sortKey: '',
        version: 1,
        ...(colorToken !== undefined ? { colorToken } : {}),
      }
      // `create` places the group after `afterGroupId` or at the end, then
      // reassigns the affected sort positions; every moved group's version
      // bumps with the ordering decision.
      const insertionIndex = afterGroupId
        ? record.groups.findIndex((group) => group.id === afterGroupId) + 1
        : record.groups.length
      const next = [...record.groups]
      next.splice(insertionIndex, 0, created)
      record = {
        ...record,
        groups: next.map((group, index) =>
          group.id === created.id ? { ...group, sortKey: sortKeyFor(index) } : group
        ),
      }
      // Existing groups whose position moved advance their version.
      record = {
        ...record,
        groups: record.groups.map((group, index) =>
          group.id !== created.id && group.sortKey !== sortKeyFor(index)
            ? { ...group, sortKey: sortKeyFor(index), version: group.version + 1 }
            : group
        ),
      }
      save()
      // The persisted record carries the assigned sort position.
      return record.groups.find((group) => group.id === created.id) ?? created
    },
    'dev.group.update': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.group.update'].request(command.body)
      const groupId = body.groupId as string
      const expectedVersion = body.expectedVersion as number
      const patch = body.patch as { name?: string; colorToken?: string }
      requireGroupResource(command, groupId)
      const group = record.groups.find((entry) => entry.id === groupId)
      if (!group) throw new DevAuthorityError('not_found', `group ${groupId} is unknown`)
      if (group.version !== expectedVersion)
        throw new DevAuthorityError(
          'stale_version',
          `group ${group.id} moved on: version ${group.version}`,
          group.version
        )
      const next: Group = {
        ...group,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.colorToken !== undefined ? { colorToken: patch.colorToken } : {}),
        version: group.version + 1,
      }
      record = {
        ...record,
        groups: record.groups.map((entry) => (entry.id === group.id ? next : entry)),
      }
      save()
      return next
    },
    'dev.group.delete': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.group.delete'].request(command.body)
      const groupId = body.groupId as string
      requireGroupResource(command, groupId)
      const group = record.groups.find((entry) => entry.id === groupId)
      if (!group) throw new DevAuthorityError('not_found', `group ${groupId} is unknown`)
      if (group.version !== (body.expectedVersion as number))
        throw new DevAuthorityError(
          'stale_version',
          `group ${group.id} moved on: version ${group.version}`,
          group.version
        )
      if (group.projectIds.length > 0)
        throw new DevAuthorityError(
          'invalid_state',
          `group ${group.id} still contains projects; move or remove them first`
        )
      record = { ...record, groups: record.groups.filter((entry) => entry.id !== groupId) }
      save()
      return group
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
    'dev.project.import': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.import'].request(command.body)
      const name = body.name as string
      const rootBookmarkId = body.rootBookmarkId as string
      const groupIds = body.groupIds as string[]
      const preferredRuntimeNodeId = body.preferredRuntimeNodeId as string | undefined
      // The canonical root never comes from the command: the composition
      // resolves the authorized bookmark fail-closed (unknown, revoked,
      // drifted, or replaced roots throw before this record is touched).
      if (!input.resolveImportRoot) {
        throw new DevAuthorityError(
          'not_found',
          'no authorized root authority is available for project import'
        )
      }
      const root = input.resolveImportRoot(rootBookmarkId)
      // One canonical root is imported once: a second registration for the
      // same bookmark is an identity collision, not a silent duplicate.
      if (
        record.projects.some((project) =>
          project.repos?.some((repo) => repo.rootBookmarkId === rootBookmarkId)
        )
      )
        throw new DevAuthorityError(
          'identity_mismatch',
          'a project is already registered for this authorized root'
        )
      for (const groupId of groupIds)
        if (!record.groups.some((group) => group.id === groupId))
          throw new DevAuthorityError('not_found', `group ${groupId} is unknown`)
      const repoId = randomUUID()
      const created: Project = {
        id: randomUUID(),
        scope: input.scope,
        name,
        groupIds: [...groupIds],
        repoIds: [repoId],
        repos: [{ repoId, rootBookmarkId, canonicalRoot: root.canonicalRoot }],
        lifecycle: 'ready',
        version: 1,
        ...(preferredRuntimeNodeId !== undefined ? { preferredRuntimeNodeId } : {}),
      }
      // One atomic snapshot write keeps the project and every group's
      // membership ordering consistent.
      record = {
        ...record,
        projects: [...record.projects, created],
        groups: record.groups.map((group) =>
          groupIds.includes(group.id)
            ? {
                ...group,
                projectIds: [...group.projectIds, created.id],
                version: group.version + 1,
              }
            : group
        ),
      }
      save()
      return created
    },
    'dev.project.create': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.create'].request(command.body)
      const groupIds = body.groupIds as string[]
      for (const groupId of groupIds)
        if (!record.groups.some((group) => group.id === groupId))
          throw new DevAuthorityError('not_found', `group ${groupId} is unknown`)
      const created: Project = {
        id: randomUUID(),
        scope: input.scope,
        name: body.name as string,
        groupIds: [...groupIds],
        repoIds: [...(body.repoIds as string[])],
        lifecycle: 'ready',
        version: 1,
        ...(body.preferredRuntimeNodeId !== undefined
          ? { preferredRuntimeNodeId: body.preferredRuntimeNodeId as string }
          : {}),
        ...(body.defaultBaseRef !== undefined
          ? { defaultBaseRef: body.defaultBaseRef as string }
          : {}),
        ...(body.bootstrapWorkflowId !== undefined
          ? { bootstrapWorkflowId: body.bootstrapWorkflowId as string }
          : {}),
        ...(body.defaultHarnessId !== undefined
          ? { defaultHarnessId: body.defaultHarnessId as string }
          : {}),
      }
      record = {
        ...record,
        projects: [...record.projects, created],
        groups: record.groups.map((group) =>
          groupIds.includes(group.id)
            ? {
                ...group,
                projectIds: [...group.projectIds, created.id],
                version: group.version + 1,
              }
            : group
        ),
      }
      save()
      return created
    },
    'dev.project.update': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.update'].request(command.body)
      const projectId = body.projectId as string
      const expectedVersion = body.expectedVersion as number
      const patch = body.patch as {
        name?: string
        groupIds?: string[]
        preferredRuntimeNodeId?: string
        defaultBaseRef?: string
        bootstrapWorkflowId?: string
        defaultHarnessId?: string
      }
      requireProjectResource(command, projectId)
      const project = record.projects.find((entry) => entry.id === projectId)
      if (!project) throw new DevAuthorityError('not_found', `project ${projectId} is unknown`)
      if (project.version !== expectedVersion)
        throw new DevAuthorityError(
          'stale_version',
          `project ${project.id} moved on: version ${project.version}`,
          project.version
        )
      if (project.lifecycle === 'archived')
        throw new DevAuthorityError(
          'invalid_state',
          `project ${project.id} is archived; unarchive it before editing`
        )
      // Group membership is validated against known groups before any write:
      // an unknown group in the patch refuses the whole update.
      const nextGroupIds = patch.groupIds ?? project.groupIds
      for (const groupId of nextGroupIds)
        if (!record.groups.some((group) => group.id === groupId))
          throw new DevAuthorityError('not_found', `group ${groupId} is unknown`)
      const next: Project = {
        ...project,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.groupIds !== undefined ? { groupIds: [...patch.groupIds] } : {}),
        ...(patch.preferredRuntimeNodeId !== undefined
          ? { preferredRuntimeNodeId: patch.preferredRuntimeNodeId }
          : {}),
        ...(patch.defaultBaseRef !== undefined ? { defaultBaseRef: patch.defaultBaseRef } : {}),
        ...(patch.bootstrapWorkflowId !== undefined
          ? { bootstrapWorkflowId: patch.bootstrapWorkflowId }
          : {}),
        ...(patch.defaultHarnessId !== undefined
          ? { defaultHarnessId: patch.defaultHarnessId }
          : {}),
        version: project.version + 1,
      }
      // One atomic snapshot write keeps the project and every affected
      // group's membership ordering consistent (adds and removals together).
      const before = new Set(project.groupIds)
      const after = new Set(next.groupIds)
      record = {
        ...record,
        projects: record.projects.map((entry) => (entry.id === project.id ? next : entry)),
        groups: record.groups.map((group) => {
          const gained = after.has(group.id) && !before.has(group.id)
          const lost = before.has(group.id) && !after.has(group.id)
          if (!gained && !lost) return group
          return {
            ...group,
            projectIds: gained
              ? [...group.projectIds, project.id]
              : group.projectIds.filter((id) => id !== project.id),
            version: group.version + 1,
          }
        }),
      }
      save()
      publishProject(next, 'project.updated')
      return next
    },
    'dev.project.archive': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.archive'].request(command.body)
      const projectId = body.projectId as string
      const expectedVersion = body.expectedVersion as number
      const archived = body.archived as boolean
      requireProjectResource(command, projectId)
      const project = record.projects.find((entry) => entry.id === projectId)
      if (!project) throw new DevAuthorityError('not_found', `project ${projectId} is unknown`)
      if (project.version !== expectedVersion)
        throw new DevAuthorityError(
          'stale_version',
          `project ${project.id} moved on: version ${project.version}`,
          project.version
        )
      if (archived === (project.lifecycle === 'archived'))
        throw new DevAuthorityError(
          'invalid_state',
          `project ${project.id} is ${archived ? 'already archived' : 'not archived'}`
        )
      if (archived) {
        // Archive is navigation metadata only — it never stops or deletes —
        // so it refuses while any session on the project is still live.
        const live = record.sessions.filter(
          (session) =>
            session.projectId === project.id &&
            !session.archived &&
            LIVE_SESSION_STATES.has(session.lifecycle)
        )
        if (live.length > 0)
          throw new DevAuthorityError(
            'invalid_state',
            `project ${project.id} still has ${live.length} live session(s); archive them first`
          )
      }
      const next: Project = {
        ...project,
        lifecycle: archived ? 'archived' : 'ready',
        version: project.version + 1,
      }
      record = {
        ...record,
        projects: record.projects.map((entry) => (entry.id === project.id ? next : entry)),
      }
      save()
      publishProject(next, archived ? 'project.archived' : 'project.unarchived')
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
    findRepoBindings(repoId) {
      return record.projects.flatMap((project) =>
        (project.repos ?? [])
          .filter((repo) => repo.repoId === repoId)
          .map((repo) => ({
            repoId: repo.repoId,
            rootBookmarkId: repo.rootBookmarkId,
            canonicalRoot: repo.canonicalRoot,
            projectId: project.id,
          }))
      )
    },
    archiveRecords: () => [...record.archiveRecords],
  }
}
