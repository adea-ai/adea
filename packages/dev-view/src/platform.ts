import type {
  CapabilitySnapshot,
  DevCommand,
  DevErrorCode,
  DevReply,
  DevStreamFrame,
  DevStreamGrant,
  Scope,
} from '@adea-ai/types/dev-runtime'
import { devOperationCapabilities } from '@adea-ai/types/dev-runtime-operation-metadata'

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
/**
 * The Dev register's flat projection: one entry per local repository binding,
 * keyed by the cloud project id. The register holds no names, order, or
 * groups — the cloud project list owns those — so hosts supply display names
 * through `DevProjectNames` and order follows the projection.
 */
export type DevWorkspaceProjection = Readonly<{
  observedAt?: string
  projects: readonly Readonly<{
    /** The cloud project id the binding is keyed by. */
    id: string
    repoIds: readonly string[]
    /** The binding's default base ref, or empty when none is set. */
    branch: string
    version?: number
    sessions: readonly Readonly<{
      id: string
      title: string
      /**
       * The session's own worktree. Panes resolve their worktree from this
       * rather than taking the first ready one on the node, which showed and
       * committed against the wrong worktree whenever a node had more than
       * one. `RuntimeSession.worktreeId` is required upstream, so this is
       * required too.
       */
      worktreeId: string
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
      /** The session primary PTY; absence never selects another terminal. */
      terminalId?: string
    }>[]
  }>[]
}>

/** Host-supplied display names keyed by cloud project id. */
export type DevProjectNames = ReadonlyMap<string, string>

/**
 * The display label for a bound project: the host's cloud project name when
 * known, otherwise the short form of the project id (its first UUID group).
 */
export function devProjectDisplayName(projectId: string, names?: DevProjectNames): string {
  const name = names?.get(projectId)?.trim()
  if (name) return name
  return projectId.split('-')[0] || projectId
}

/** One attached, single-use stream socket over the authenticated channel
 *  (`dev.runtime.stream.attach.v1`). */
export type DevStreamTransportSocket = {
  /** Measured locally queued and in-flight relay bytes, when the provider supports it. */
  readonly bufferedAmount?: number
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
  const capabilities = devOperationCapabilities

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
