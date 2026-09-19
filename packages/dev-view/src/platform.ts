import type {
  CapabilitySnapshot,
  DevCommand,
  DevErrorCode,
  DevReply,
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

export interface DevRuntimeService {
  state(): DevRuntimeAvailability
  /** Authoritative preference scope, absent until a runtime channel is bound. */
  preferenceScope?(): Scope | undefined
  projection?(scope: Scope): Promise<DevWorkspaceProjection>
  capabilitySnapshot(scope: Scope): Promise<CapabilitySnapshot>
  execute(command: DevCommand): Promise<DevReply>
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
