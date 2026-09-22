import { buildDevCommand } from '@adea-ai/dev-view/browser'
import {
  createUnavailableDevRuntimeService,
  type DevEventSubscription,
  type DevGitStatusInvalidated,
  type DevRuntimeService,
  type DevStreamTransport,
  type DevWorkspaceProjection,
} from '@adea-ai/dev-view/platform'
import type { DevCommand, DevReply, Scope } from '@adea-ai/types/dev-runtime'

import { createDesktopStreamTransport } from './desktop-stream-transport'

/** The structural slice of the injected bridge this module touches. Declared
 *  locally, never imported: the boundary test pins that this module does not
 *  depend on the desktop-bridge module — the injected `window.__adeaDesktop`
 *  global is the only channel to the shell, and even a type-only import would
 *  start couples this file to its module graph. */
type BridgeLike = {
  invoke?: unknown
  devExecute?: unknown
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>
}

/** The shell event the git status-invalidation pushes ride (published by the
 *  composition's watcher lane; delivered over the gateway's authenticated
 *  SSE stream through the bridge's signed listen path). */
export const GIT_STATUS_INVALIDATED_EVENT = 'git.statusInvalidated'

/** The capability that gates `dev.git.status` — and with it the push
 *  invalidation events derived from the same lane. */
const GIT_STATUS_CAPABILITY = 'dev.git.read'

const STATUS_INVALIDATED_REASONS: ReadonlySet<string> = new Set([
  'tree_changed',
  'refreshed',
  'degraded',
  'refenced',
  'stopped',
])

/**
 * Structural guard for the SSE event payload. Transport bytes are untrusted:
 * a payload that does not carry the four typed fields is dropped, never
 * delivered — a malformed frame can never reach a pane. Unknown extra fields
 * are tolerated (additive payload evolution), the known fields are required.
 */
export function decodeStatusInvalidated(value: unknown): DevGitStatusInvalidated | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.worktreeId !== 'string' || candidate.worktreeId.length === 0)
    return undefined
  if (typeof candidate.generation !== 'number' || !Number.isSafeInteger(candidate.generation))
    return undefined
  if (typeof candidate.revision !== 'number' || !Number.isSafeInteger(candidate.revision))
    return undefined
  if (typeof candidate.reason !== 'string' || !STATUS_INVALIDATED_REASONS.has(candidate.reason))
    return undefined
  return {
    worktreeId: candidate.worktreeId,
    generation: candidate.generation,
    revision: candidate.revision,
    reason: candidate.reason as DevGitStatusInvalidated['reason'],
  }
}

/**
 * Builds the push-event surface from the injected bridge (M12): typed,
 * capability-checked, generation-fenced delivery of the shell's
 * `git.statusInvalidated` events over the bridge's existing signed listen
 * path. Capability check: a scope is subscribed only when its capability
 * snapshot (read through the authenticated command path) grants
 * `dev.git.read` — fail closed. Returns undefined when the bridge predates
 * the listen surface; consumers then keep generation-fenced pull.
 */
export function createDesktopEventSurface(options: {
  bridge: BridgeLike
  execute: (command: DevCommand) => Promise<DevReply>
}): DevEventSubscription | undefined {
  const { bridge, execute } = options
  if (typeof bridge.listen !== 'function') return undefined

  /** Capability gate: subscribe only when the scope may read git status. */
  async function maySubscribe(scope: Scope): Promise<boolean> {
    try {
      const command = buildDevCommand({
        operation: 'dev.capability.snapshot',
        scope,
        body: {},
      })
      const reply = await execute(command)
      if (!reply.ok) return false
      const snapshot = reply.value as { granted?: readonly string[] } | undefined
      return (snapshot?.granted ?? []).includes(GIT_STATUS_CAPABILITY)
    } catch {
      return false
    }
  }

  return {
    on(event, scope, listener) {
      if (event !== 'git.statusInvalidated') return () => undefined
      let closed = false
      let dispose: (() => void) | undefined
      void (async () => {
        if (!(await maySubscribe(scope))) return // fail closed: no transport, no listener
        if (closed) return
        try {
          dispose = await bridge.listen(GIT_STATUS_INVALIDATED_EVENT, (message) => {
            if (closed) return
            const payload = (message as { payload?: unknown } | undefined)?.payload
            const parsed = decodeStatusInvalidated(payload)
            if (!parsed) return // malformed frame dropped, never trusted
            listener(parsed)
          })
          if (closed) dispose()
        } catch {
          dispose = undefined // push unavailable; pull remains the fallback
        }
      })()
      return () => {
        closed = true
        try {
          dispose?.()
        } catch {
          /* teardown is best-effort */
        }
        dispose = undefined
      }
    },
  }
}

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
  // Bulk-stream attach surface (#399 residue): present only when the injected
  // bridge carries the relay signing seam; otherwise panes keep the bounded
  // control path. The channel secret never crosses into this layer.
  const streams = bridge ? createDesktopStreamTransport({ bridge }) : undefined
  // Push-event surface (M12): typed, capability-checked, generation-fenced
  // delivery of `git.statusInvalidated` over the bridge's signed listen path.
  // Absent on a web non-desktop runtime — panes keep generation-fenced pull.
  const events = bridge && execute ? createDesktopEventSurface({ bridge, execute }) : undefined

  if (options.scope) {
    return createBoundService({ execute, shellScope: options.scope, streams, events })
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
    ready: projectedScope.then(() => undefined),
    state: () =>
      shellScope
        ? { status: 'ready' as const }
        : {
            status: 'unavailable' as const,
            reason: 'channel_unauthenticated' as const,
          },
    preferenceScope: () => shellScope,
    ...(streams ? { streams: () => streams } : {}),
    ...(events ? { events: () => events } : {}),
    projection: async (requestedScope) => {
      const scope = await projectedScope
      if (!scope) {
        throw new Error(bindRefusal?.message ?? 'identity scope is unbound')
      }
      if (!sameScope(scope, requestedScope)) {
        throw new Error('requested scope does not match the shell binding')
      }
      const [groups, projects, sessions] = await Promise.all([
        executeOperation(execute, 'dev.group.list', scope, {}),
        executeOperation(execute, 'dev.project.list', scope, {}),
        executeOperation(execute, 'dev.session.list', scope, {}),
      ])
      return toProjection(groups, projects, sessions)
    },
    capabilitySnapshot: async (requestedScope) => {
      const scope = await projectedScope
      if (!scope || !sameScope(scope, requestedScope)) {
        return unavailable.capabilitySnapshot(requestedScope)
      }
      const command = buildDevCommand({
        operation: 'dev.capability.snapshot',
        scope,
        body: {},
      })
      const reply = await execute(command)
      return reply.ok ? readSnapshot(reply, scope) : unavailable.capabilitySnapshot(requestedScope)
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
 *  construction; commands are still checked against the shell at the gate. */
function createBoundService(options: {
  execute?: (command: DevCommand) => Promise<DevReply>
  shellScope: Scope
  streams?: DevStreamTransport
  events?: DevEventSubscription
}): DevRuntimeService {
  const { shellScope } = options
  const execute = options.execute
  const unavailable = createUnavailableDevRuntimeService({ reason: 'channel_unauthenticated' })
  if (!execute) return unavailable
  return {
    state: () => ({ status: 'ready' }),
    preferenceScope: () => shellScope,
    ...(options.streams ? { streams: () => options.streams } : {}),
    ...(options.events ? { events: () => options.events } : {}),
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
      const reply = await execute(command)
      return reply.ok
        ? readSnapshot(reply, requestedScope)
        : unavailable.capabilitySnapshot(requestedScope)
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
