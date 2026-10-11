import type { Scope } from '@adea-ai/types/dev-runtime'
import type { DevRuntimeService } from './platform'

/** The visible workspace surface that currently owns the contextual utilities. */
export type DevUtilityView = 'dev' | 'chat' | 'virtual' | 'workspace'

/**
 * Canonical context for reads and actions launched from a utility pane.
 * Session-bound panes require the project, RuntimeSession ID, and generation;
 * a room, channel, route, or stale Dev selection cannot fill these fields.
 */
export type DevUtilityContext = Readonly<{
  view: DevUtilityView
  runtime: DevRuntimeService
  scope?: Scope
  projectId?: string
  runtimeSessionId?: string
  sessionGeneration?: number
  worktreeId?: string
  revision: number
}>

export type DevUtilityContextInput = Omit<DevUtilityContext, 'revision'>

/** A projection-validated session identity handed off by Dev or Desktop Chat. */
export type CanonicalRuntimeBinding = Readonly<{
  scope: Scope
  projectId: string
  runtimeSessionId: string
  sessionGeneration: number
  worktreeId?: string
}>

export type DevUtilityFence = Readonly<{
  context: DevUtilityContext
  key: string
  isCurrent(): boolean
}>

export type DevUtilityFenceRequirement = 'scope' | 'session'

export type DevUtilityContextReader = () => DevUtilityContext

export class DevUtilityContextUnavailableError extends Error {
  constructor() {
    super('A canonical runtime session is not available for this utility.')
    this.name = 'DevUtilityContextUnavailableError'
  }
}

export class DevUtilityContextChangedError extends Error {
  constructor() {
    super('The runtime utility context changed while the request was in flight.')
    this.name = 'DevUtilityContextChangedError'
  }
}

export function isDevUtilityContextChanged(error: unknown): boolean {
  return error instanceof DevUtilityContextChangedError
}

export function hasDevUtilitySession(context: DevUtilityContext): boolean {
  return Boolean(
    context.scope &&
    context.projectId &&
    context.runtimeSessionId &&
    Number.isSafeInteger(context.sessionGeneration) &&
    context.sessionGeneration! > 0
  )
}

export function sameDevUtilityScope(left: Scope | undefined, right: Scope | undefined): boolean {
  return Boolean(
    left &&
    right &&
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}

export function devUtilityContextKey(context: DevUtilityContext): string {
  return identityKey(context)
}

function identityKey(context: DevUtilityContext): string {
  const { scope } = context
  return JSON.stringify([
    context.view,
    scope?.accountId,
    scope?.workspaceId,
    scope?.runtimeNodeId,
    context.projectId,
    context.runtimeSessionId,
    context.sessionGeneration,
    context.worktreeId,
    context.revision,
    context.runtime.state().status,
  ])
}

/**
 * Adds a monotonic context revision to a live shell snapshot. The revision
 * tracks observed identity changes. Shell owners supply a durable transition
 * epoch so A → B → A also invalidates deferred work without an intermediate read.
 */
export function createDevUtilityContext(
  read: () => DevUtilityContextInput,
  readTransitionEpoch: () => number = () => 0
): () => DevUtilityContext {
  let revision = 0
  let previousRuntime: DevRuntimeService | undefined
  let previousIdentity: string | undefined

  return () => {
    const next = read()
    const identity = JSON.stringify([
      readTransitionEpoch(),
      next.view,
      next.scope?.accountId,
      next.scope?.workspaceId,
      next.scope?.runtimeNodeId,
      next.projectId,
      next.runtimeSessionId,
      next.sessionGeneration,
      next.worktreeId,
      next.runtime.state().status,
    ])
    if (previousIdentity !== identity || previousRuntime !== next.runtime) {
      revision += 1
      previousIdentity = identity
      previousRuntime = next.runtime
    }
    return { ...next, revision }
  }
}

/**
 * Capture a request fence before crossing the runtime boundary. Call
 * `isCurrent()` after every await and before applying results or starting a
 * follow-up action. Disposing the pane invalidates every outstanding fence.
 */
export function createDevUtilityFenceSource(read: () => DevUtilityContext) {
  let disposed = false

  return {
    capture(requirement: DevUtilityFenceRequirement = 'scope'): DevUtilityFence | undefined {
      if (disposed) return undefined
      const context = read()
      if (!context.scope) return undefined
      if (
        requirement === 'session' &&
        (!context.projectId ||
          !context.runtimeSessionId ||
          !Number.isSafeInteger(context.sessionGeneration) ||
          context.sessionGeneration! < 1)
      )
        return undefined
      const key = identityKey(context)
      return {
        context,
        key,
        isCurrent: () => !disposed && key === identityKey(read()),
      }
    },
    dispose(): void {
      disposed = true
    },
  }
}
