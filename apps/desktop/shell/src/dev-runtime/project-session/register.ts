import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type {
  ArchiveRecord,
  DevCommand,
  DevOperation,
  Group,
  DevRuntimePage,
  Project,
  RuntimeSession,
  Scope,
} from '../../../../../../packages/types/src/dev-runtime'
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
  return { items, observedAt: new Date().toISOString() }
}

function requireScope(command: DevCommand, scope: Scope): void {
  if (!sameScope(command.scope, scope)) throw new Error('project/session scope is not authorized')
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
      const project = record.projects.find(
        (entry) => entry.id === (command.body as { projectId: string }).projectId
      )
      if (!project) throw new Error('project not found')
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
      if (!group || group.version !== body.expectedGroupVersion)
        throw new Error('group version conflict')
      const known = new Set(group.projectIds)
      if (body.orderedProjectIds.some((id) => !known.has(id)))
        throw new Error('project reorder contains a foreign project')
      const next = { ...group, projectIds: [...body.orderedProjectIds], version: group.version + 1 }
      record = {
        ...record,
        groups: record.groups.map((entry) => (entry.id === group.id ? next : entry)),
      }
      save()
      return next
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
      const session = record.sessions.find(
        (entry) => entry.id === (command.body as { runtimeSessionId: string }).runtimeSessionId
      )
      if (!session) throw new Error('runtime session not found')
      return session
    },
    'dev.session.archive': (command) => {
      requireScope(command, input.scope)
      const body = command.body as {
        runtimeSessionId: string
        expectedGeneration: number
        reason?: string
      }
      const session = record.sessions.find((entry) => entry.id === body.runtimeSessionId)
      if (!session) throw new Error('runtime session not found')
      if (session.generation !== body.expectedGeneration)
        throw new Error('runtime session generation conflict')
      const next = { ...session, archived: true, version: session.version + 1 }
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
      }
      save()
      return archiveRecord(next, input.scope, 'archived', body.reason)
    },
    'dev.session.unarchive': (command) => {
      requireScope(command, input.scope)
      const body = command.body as { runtimeSessionId: string; expectedGeneration: number }
      const session = record.sessions.find((entry) => entry.id === body.runtimeSessionId)
      if (!session) throw new Error('runtime session not found')
      if (session.generation !== body.expectedGeneration)
        throw new Error('runtime session generation conflict')
      const next = { ...session, archived: false, version: session.version + 1 }
      record = {
        ...record,
        sessions: record.sessions.map((entry) => (entry.id === session.id ? next : entry)),
      }
      save()
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
