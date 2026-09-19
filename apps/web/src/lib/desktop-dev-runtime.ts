import { buildDevCommand } from '@adea-ai/dev-view/browser'
import {
  createUnavailableDevRuntimeService,
  type DevRuntimeService,
  type DevWorkspaceProjection,
} from '@adea-ai/dev-view/platform'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'
type DesktopBridge = {
  devExecute?: (command: unknown) => Promise<unknown>
}

declare global {
  interface Window {
    __ADEA_DEV_SCOPE__?: Scope
  }
}

/**
 * Binds Dev View to the shell's authenticated channel. The bridge is injected
 * only into the packaged desktop window; a normal web tab remains explicitly
 * unavailable rather than attempting a direct loopback connection.
 */
export function createDesktopDevRuntimeService(options: { scope?: Scope } = {}): DevRuntimeService {
  const unavailable = createUnavailableDevRuntimeService({ reason: 'channel_unauthenticated' })
  const bridge = typeof window === 'undefined' ? undefined : window.__adeaDesktop
  const execute = bridge?.devExecute as ((command: DevCommand) => Promise<DevReply>) | undefined
  const scope =
    options.scope ?? (typeof window === 'undefined' ? undefined : window.__ADEA_DEV_SCOPE__)

  if (!execute || !scope) return unavailable

  return {
    state: () => ({ status: 'ready' }),
    preferenceScope: () => scope,
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

async function executeOperation(
  execute: NonNullable<DesktopBridge['devExecute']>,
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
