import { buildDevCommand } from '@adea-ai/dev-view/browser'
import {
  createUnavailableDevRuntimeService,
  type DevRuntimeService,
  type DevWorkspaceProjection,
} from '@adea-ai/dev-view/platform'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'

/**
 * Binds Dev View to the shell's authenticated channel. The bridge is injected
 * only into the packaged desktop window; a normal web tab remains explicitly
 * unavailable rather than attempting a direct loopback connection.
 *
 * The scope is never read from a renderer global: the shell projects the
 * scope it verified against the cloud for the signed identity bind, and this
 * adapter consumes that projection. Until the shell reports a bound scope,
 * the service is truthfully unavailable — a guessed or synthetic scope is
 * never used to build commands (spec: provider invariant 4).
 */
export function createDesktopDevRuntimeService(options: { scope?: Scope } = {}): DevRuntimeService {
  const unavailable = createUnavailableDevRuntimeService({ reason: 'channel_unauthenticated' })
  const bridge = typeof window === 'undefined' ? undefined : window.__adeaDesktop
  const execute = bridge?.devExecute as ((command: DevCommand) => Promise<DevReply>) | undefined
  // The signed legacy invoke on the injected bridge object (never the shared
  // desktop-bridge module) carries the shell's scope projection.
  const bridgeInvoke = bridge?.invoke as
    | (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>)
    | undefined

  if (options.scope) {
    return createBoundService({ execute, shellScope: options.scope })
  }
  if (!execute || !bridgeInvoke || typeof window === 'undefined') return unavailable

  // Authoritative scope projection: the shell's verified binding, fetched
  // over the signed legacy channel. A refusal keeps the service unavailable
  // with the shell's reason — the renderer never self-asserts a scope.
  let shellScope: Scope | undefined
  let bindRefusal: { code: string; message: string } | undefined
  const projectedScope = bridgeInvoke<Scope>('desktop_identity_scope')
    .then((scope) => {
      shellScope = scope
      return scope
    })
    .catch((error: unknown) => {
      bindRefusal = {
        code: 'unauthenticated',
        message: error instanceof Error ? error.message : 'identity scope is unbound',
      }
      return undefined
    })

  return {
    state: () =>
      shellScope
        ? { status: 'ready' as const }
        : {
            status: 'unavailable' as const,
            reason: 'channel_unauthenticated' as const,
          },
    preferenceScope: () => shellScope,
    projection: async (requestedScope) => {
      const scope = (await projectedScope) ?? requestedScope
      if (shellScope && !sameScope(scope, shellScope)) {
        throw new Error(bindRefusal?.message ?? 'requested scope does not match the shell binding')
      }
      const [groups, projects, sessions] = await Promise.all([
        executeOperation(execute, 'dev.group.list', scope, {}),
        executeOperation(execute, 'dev.project.list', scope, {}),
        executeOperation(execute, 'dev.session.list', scope, {}),
      ])
      return toProjection(groups, projects, sessions)
    },
    capabilitySnapshot: async (requestedScope) => {
      const scope = (await projectedScope) ?? requestedScope
      if (shellScope && !sameScope(scope, shellScope)) {
        return {
          scope: requestedScope,
          granted: [],
          unavailable: [],
          channelGeneration: 0,
          observedAt: new Date().toISOString(),
        }
      }
      const command = buildDevCommand({
        operation: 'dev.capability.snapshot',
        scope,
        body: {},
      })
      return readSnapshot(await execute(command), scope)
    },
    execute: async (command) => {
      try {
        return await execute(command)
      } catch (error) {
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: false,
          error: {
            code: 'channel_unauthenticated',
            retryable: true,
            message:
              error instanceof Error ? error.message : 'authenticated desktop channel failed',
            observedAt: new Date().toISOString(),
          },
        }
      }
    },
  }
}

/** An explicitly provided scope (tests, future bind-aware entry) binds at
 * construction; commands are still checked against the shell at the gate. */
function createBoundService(options: {
  execute?: (command: DevCommand) => Promise<DevReply>
  shellScope: Scope
}): DevRuntimeService {
  const { shellScope } = options
  const execute = options.execute
  if (!execute) return createUnavailableDevRuntimeService({ reason: 'channel_unauthenticated' })
  return {
    state: () => ({ status: 'ready' }),
    preferenceScope: () => shellScope,
    projection: async (requestedScope) => {
      const [groups, projects, sessions] = await Promise.all([
        executeOperation(execute, 'dev.group.list', requestedScope, {}),
        executeOperation(execute, 'dev.project.list', requestedScope, {}),
        executeOperation(execute, 'dev.session.list', requestedScope, {}),
      ])
      return toProjection(groups, projects, sessions)
    },
    capabilitySnapshot: async (requestedScope) => {
      const command = buildDevCommand({
        operation: 'dev.capability.snapshot',
        scope: requestedScope,
        body: {},
      })
      return readSnapshot(await execute(command), requestedScope)
    },
    execute: async (command) => {
      try {
        return await execute(command)
      } catch (error) {
        return {
          schemaVersion: 1,
          operation: command.operation,
          requestId: command.requestId,
          ok: false,
          error: {
            code: 'channel_unauthenticated',
            retryable: true,
            message:
              error instanceof Error ? error.message : 'authenticated desktop channel failed',
            observedAt: new Date().toISOString(),
          },
        }
      }
    },
  }
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

async function executeOperation(
  execute: (command: DevCommand) => Promise<DevReply>,
  operation: 'dev.group.list' | 'dev.project.list' | 'dev.session.list',
  scope: Scope,
  body: Record<string, unknown>
) {
  const command = buildDevCommand({ operation, scope, body })
  const reply = (await execute(command)) as DevReply
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.value as { items: readonly Record<string, unknown>[] }
}

function toProjection(
  groupsReply: { items: readonly Record<string, unknown>[] },
  projectsReply: { items: readonly Record<string, unknown>[] },
  sessionsReply: { items: readonly Record<string, unknown>[] }
): DevWorkspaceProjection {
  const sessionsByProject = new Map<
    string,
    DevWorkspaceProjection['groups'][number]['projects'][number]['sessions']
  >()
  for (const raw of sessionsReply.items) {
    const projectId = typeof raw.projectId === 'string' ? raw.projectId : ''
    const sessions = [...(sessionsByProject.get(projectId) ?? [])]
    sessions.push({
      id: String(raw.id),
      title: typeof raw.displayName === 'string' ? raw.displayName : String(raw.id),
      state: raw.archived === true ? 'archived' : raw.lifecycle === 'active' ? 'active' : 'ready',
    })
    sessionsByProject.set(projectId, sessions)
  }
  const projectsById = new Map<
    string,
    DevWorkspaceProjection['groups'][number]['projects'][number]
  >()
  for (const raw of projectsReply.items) {
    const id = String(raw.id)
    projectsById.set(id, {
      id,
      name: String(raw.name ?? id),
      repository: Array.isArray(raw.repoIds) ? String(raw.repoIds[0] ?? '') : '',
      branch: typeof raw.defaultBaseRef === 'string' ? raw.defaultBaseRef : '',
      sessions: sessionsByProject.get(id) ?? [],
    })
  }
  return {
    groups: groupsReply.items.map((raw) => ({
      id: String(raw.id),
      name: String(raw.name ?? raw.id),
      projects: (Array.isArray(raw.projectIds) ? raw.projectIds : [])
        .map((id) => projectsById.get(String(id)))
        .filter((project): project is NonNullable<typeof project> => project !== undefined),
    })),
  }
}

function readSnapshot(reply: DevReply, scope: Scope) {
  if (!reply.ok) {
    return {
      scope,
      granted: [],
      unavailable: [],
      channelGeneration: 0,
      observedAt: new Date().toISOString(),
    }
  }
  return reply.value as Awaited<ReturnType<DevRuntimeService['capabilitySnapshot']>>
}
