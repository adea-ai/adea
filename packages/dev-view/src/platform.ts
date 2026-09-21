import type {
  CapabilitySnapshot,
  DevCommand,
  DevErrorCode,
  DevReply,
  DevStreamFrame,
  DevStreamGrant,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { devOperationDefinitions } from '@adea-ai/types/dev-runtime'

export type DevRuntimeAvailability =
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'unavailable'; reason: DevErrorCode }>

/**
 * The authoritative Dev workspace projection: groups, projects, and canonical
 * `RuntimeSession` records from the runtime service. Optional versioning and
 * freshness fields are carried when the provider maps them; the production
 * selection uses them for reorder concurrency and stale detection, and never
 * invents them when absent.
 */
export type DevWorkspaceProjection = Readonly<{
  observedAt?: string
  groups: readonly Readonly<{
    id: string
    name: string
    version?: number
    projects: readonly Readonly<{
      id: string
      name: string
      repository: string
      branch: string
      version?: number
      sessions: readonly Readonly<{
        id: string
        title: string
        /**
         * The canonical RuntimeSession lifecycle from the register (#398).
         * States beyond the historical three render with a neutral status
         * dot and their own accessible name instead of being coerced into
         * `active`/`ready`.
         */
        state:
          | 'preparing'
          | 'ready'
          | 'active'
          | 'disconnected'
          | 'completed'
          | 'failed'
          | 'cancelled'
          | 'archived'
        generation?: number
      }>[]
    }>[]
  }>[]
}>

/** One attached, single-use stream socket over the authenticated channel
 *  (`dev.runtime.stream.attach.v1`). */
export type DevStreamTransportSocket = {
  readonly open: boolean
  send(frame: DevStreamFrame): void
  close(code: number, reason: string): void
}

/** The host-side stream attach seam (#399 residue): attaches a minted
 *  `DevStreamGrant` and hands back the socket. Panes consume it through the
 *  pure file-stream model, never directly. */
export type DevStreamTransport = {
  connect(
    grant: DevStreamGrant,
    handlers: {
      onFrame: (frame: DevStreamFrame) => void
      onClose: (code: number, reason: string) => void
    }
  ): DevStreamTransportSocket
}

/**
 * The renderer mirror of the shell watcher lane's status-invalidation event
 * (`git.statusInvalidated` on the gateway's authenticated SSE stream). The
 * payload is secret-free by construction and every field is shell-authored;
 * it is still transport bytes to the renderer, so the delivery surface
 * structurally validates it before any listener runs. Generation-fenced:
 * consumers compare `generation` against the worktree context they hold.
 */
export type DevGitStatusInvalidated = Readonly<{
  worktreeId: string
  /** The worktree generation the invalidation is fenced by. */
  generation: number
  /** Monotonic invalidation counter for the source watcher. */
  revision: number
  reason: 'tree_changed' | 'refreshed' | 'degraded' | 'refenced' | 'stopped'
}>

/** The typed push-event map the service can deliver. */
export type DevRuntimeEventMap = Readonly<{
  'git.statusInvalidated': DevGitStatusInvalidated
}>

/**
 * The push-event subscription surface: delivers named shell events from the
 * gateway's signed event stream. Subscriptions are capability-checked (a
 * scope whose capability snapshot does not grant the operation's capability
 * is never subscribed — fail closed) and generation-fenced (events carry the
 * generation they were produced under). Returns an unsubscribe; the surface
 * staying absent keeps panes on generation-fenced pull.
 */
export type DevEventSubscription = {
  on<K extends keyof DevRuntimeEventMap>(
    event: K,
    scope: Scope,
    listener: (event: DevRuntimeEventMap[K]) => void
  ): () => void
}

export interface DevRuntimeService {
  state(): DevRuntimeAvailability
  /** Resolves when an asynchronous runtime channel has finished binding. */
  ready?: Promise<void>
  /** Authoritative preference scope, absent until a runtime channel is bound. */
  preferenceScope?(): Scope | undefined
  projection?(scope: Scope): Promise<DevWorkspaceProjection>
  capabilitySnapshot(scope: Scope): Promise<CapabilitySnapshot>
  execute(command: DevCommand): Promise<DevReply>
  /** Optional bulk-stream attach surface: present only when the host can
   *  attach minted stream grants; absent (or resolving undefined) keeps the
   *  panes on the bounded control path. */
  streams?(): DevStreamTransport | undefined
  /** Optional push-event surface: present only when the host can deliver the
   *  gateway's signed event stream to this renderer (the packaged desktop
   *  runtime). Absent — e.g. a web non-desktop runtime — keeps every consumer
   *  on generation-fenced pull; pull is always the correctness fallback. */
  events?(): DevEventSubscription | undefined
}

export function createUnavailableDevRuntimeService(options?: {
  reason?: DevErrorCode
  now?: () => string
}): DevRuntimeService {
  const reason = options?.reason ?? 'unavailable'
  const now = options?.now ?? (() => new Date().toISOString())
  const capabilities = Array.from(
    new Set(Object.values(devOperationDefinitions).flatMap((definition) => definition.capabilities))
  )
  capabilities.sort((left, right) => left.localeCompare(right))

  return {
    state: () => ({ status: 'unavailable', reason }),
    preferenceScope: () => undefined,
    capabilitySnapshot: async (scope) => ({
      scope,
      granted: [],
      unavailable: capabilities.map((capability) => ({ capability, reason })),
      channelGeneration: 0,
      observedAt: now(),
    }),
    execute: async (command) => ({
      schemaVersion: 1,
      operation: command.operation,
      requestId: command.requestId,
      ok: false,
      error: {
        code: reason,
        retryable: false,
        message: 'Dev Runtime is unavailable until its authenticated command channel is ready.',
        observedAt: now(),
      },
    }),
  }
}
