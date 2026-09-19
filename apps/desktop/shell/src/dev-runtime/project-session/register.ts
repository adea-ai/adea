// Production project/session projection (M12 #395/#398 consumption): the one
// durable, scoped, generation-fenced RuntimeSession projection that Dev View
// and Chat both consume. Records live under the authenticated scope only;
// every operation re-checks the envelope resource binding (kind, id,
// generation) before dispatch; input ownership moves only through the
// authorized `dev.session.transferInput` operation, which bumps the
// generation so input granted under an old generation is inert. Session
// changes publish on the shell event bus so both views share one canonical
// runtimeSessionId and its event cursor.
import { randomUUID } from 'node:crypto'
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
import { createDurableJsonStore } from '../host-store'

export type ProjectSessionRuntime = Readonly<{
  providers: Partial<Record<DevOperation, (command: DevCommand) => unknown>>
  upsertProject(project: Project): void
  upsertSession(session: RuntimeSession): void
}>

type ProjectionRecord = Readonly<{
  scope: Scope
  groups: Group[]
  projects: Project[]
  sessions: RuntimeSession[]
}>

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
  const store = createDurableJsonStore<ProjectionRecord>({
    file: join(input.dataDir, 'dev-runtime', 'project-session', 'projection.json'),
    schemaVersion: 1,
    label: 'project/session projection',
  })
  let record = store.load().records[0] ?? {
    scope: input.scope,
    groups: [],
    projects: [],
    sessions: [],
  }
  if (!sameScope(record.scope, input.scope))
    record = { scope: input.scope, groups: [], projects: [], sessions: [] }
  const save = () => store.save([record])

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
    'dev.project.list': (command) => {
      requireScope(command, input.scope)
      return page(record.projects)
    },
    'dev.project.get': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.get'].request(command.body)
      const project = record.projects.find((entry) => entry.id === (body.projectId as string))
      if (!project) throw devError('not_found', 'project not found')
      return project
    },
    'dev.project.reorder': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.project.reorder'].request(command.body)
      const group = record.groups.find((entry) => entry.id === (body.groupId as string))
      if (!group || group.version !== (body.expectedGroupVersion as number)) {
        throw devError('stale_version', 'group version conflict')
      }
      const ordered = body.orderedProjectIds as string[]
      const known = new Set(group.projectIds)
      if (ordered.some((id) => !known.has(id))) {
        throw devError('identity_mismatch', 'project reorder contains a foreign project')
      }
      const next = { ...group, projectIds: [...ordered], version: group.version + 1 }
      record = {
        ...record,
        groups: record.groups.map((entry) => (entry.id === group.id ? next : entry)),
      }
      save()
      return next
    },
    'dev.session.list': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.session.list'].request(command.body)
      return page(
        record.sessions.filter((entry) => {
          return (
            (body.runtimeSessionId === undefined ||
              entry.id === (body.runtimeSessionId as string)) &&
            (body.projectId === undefined || entry.projectId === (body.projectId as string)) &&
            (body.worktreeId === undefined || entry.worktreeId === (body.worktreeId as string)) &&
            (body.archived === undefined || entry.archived === (body.archived as boolean))
          )
        })
      )
    },
    'dev.session.create': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.session.create'].request(command.body)
      if (command.resource !== undefined) {
        throw devError('identity_mismatch', 'dev.session.create carries no resource binding')
      }
      const creation = {
        projectId: body.projectId as string,
        repoId: body.repoId as string,
        worktreeId: body.worktreeId as string,
      }
      // The composition proves the referenced worktree is registered and
      // live on this node before any session record exists.
      input.validateSessionCreation?.(creation)
      const session: RuntimeSession = {
        id: randomUUID(),
        scope: { ...input.scope },
        projectId: creation.projectId,
        repoId: creation.repoId,
        worktreeId: creation.worktreeId,
        ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
        ...(typeof body.agentProfileId === 'string' ? { agentProfileId: body.agentProfileId } : {}),
        ...(typeof body.agentProfileVersion === 'number'
          ? { agentProfileVersion: body.agentProfileVersion }
          : {}),
        ...(typeof body.harnessInstallationId === 'string'
          ? { harnessInstallationId: body.harnessInstallationId }
          : {}),
        lifecycle: 'preparing',
        archived: false,
        projection: 'structured',
        generation: 1,
        version: 1,
      }
      record = { ...record, sessions: [...record.sessions, session] }
      save()
      publishSession(session, 'session.created')
      return session
    },
    'dev.session.get': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.session.get'].request(command.body)
      const session = record.sessions.find(
        (entry) => entry.id === (body.runtimeSessionId as string)
      )
      if (!session) throw devError('not_found', 'runtime session not found')
      requireSessionResource(command, session)
      return session
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
    'dev.session.archive': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.session.archive'].request(command.body)
      const session = record.sessions.find(
        (entry) => entry.id === (body.runtimeSessionId as string)
      )
      if (!session) throw devError('not_found', 'runtime session not found')
      requireSessionResource(command, session)
      if (session.generation !== (body.expectedGeneration as number)) {
        throw devError('stale_generation', 'runtime session generation conflict')
      }
      const next = { ...session, archived: true, version: session.version + 1 }
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
      }
      save()
      publishSession(next, 'session.archived')
      return archiveRecord(next, input.scope, 'archived', body.reason as string | undefined)
    },
    'dev.session.unarchive': (command) => {
      requireScope(command, input.scope)
      const body = devOperationDecoders['dev.session.unarchive'].request(command.body)
      const session = record.sessions.find(
        (entry) => entry.id === (body.runtimeSessionId as string)
      )
      if (!session) throw devError('not_found', 'runtime session not found')
      requireSessionResource(command, session)
      if (session.generation !== (body.expectedGeneration as number)) {
        throw devError('stale_generation', 'runtime session generation conflict')
      }
      const next = { ...session, archived: false, version: session.version + 1 }
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
      }
      save()
      publishSession(next, 'session.unarchived')
      return archiveRecord(next, input.scope, 'restored')
    },
  }
  for (const [operation, provider] of Object.entries(providers)) {
    input.authority.registerCommandProvider(operation as DevOperation, provider)
  }
  return {
    providers,
    upsertProject(project) {
      if (sameScope(project.scope, input.scope)) {
        record = {
          ...record,
          projects: [...record.projects.filter((entry) => entry.id !== project.id), project],
        }
        save()
      }
    },
    upsertSession(session) {
      if (sameScope(session.scope, input.scope)) {
        record = {
          ...record,
          sessions: [...record.sessions.filter((entry) => entry.id !== session.id), session],
        }
        save()
      }
    },
  }
}

function requireScope(command: DevCommand, scope: Scope): void {
  if (!sameScope(command.scope, scope)) {
    throw devError('channel_unauthorized', 'project/session scope is not authorized')
  }
}
