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

export type DevWorkspaceProjection = Readonly<{
  groups: readonly Readonly<{
    id: string
    name: string
    projects: readonly Readonly<{
      id: string
      name: string
      repository: string
      branch: string
      sessions: readonly Readonly<{
        id: string
        title: string
        state: 'active' | 'ready' | 'archived'
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
