import type { DevError, DevOperation } from '@adea-ai/types/dev-runtime'

import { buildDevCommand } from './browser/command'
import {
  DevUtilityContextChangedError,
  DevUtilityContextUnavailableError,
  isDevUtilityContextChanged,
  type DevUtilityFence,
} from './utility-context'

/** The runtime's typed failure when the rejection carries one, else a generic invalid-state error. */
export function commandError(error: unknown): DevError {
  return (
    (error as { error?: DevError })?.error ?? {
      code: 'invalid_state',
      retryable: false,
      message: error instanceof Error ? error.message : 'command failed',
    }
  )
}

/** Execute under the captured identity and fail closed if it changes in flight. */
export async function executeDevUtilityCommand<T>(
  fence: DevUtilityFence | undefined,
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): Promise<T> {
  const context = fence?.context
  if (!fence || !context?.scope) throw new DevUtilityContextUnavailableError()
  if (!fence.isCurrent()) throw new DevUtilityContextChangedError()
  const reply = await context.runtime.execute(
    buildDevCommand({
      operation,
      scope: context.scope,
      body,
      resource,
    })
  )
  if (!fence.isCurrent()) throw new DevUtilityContextChangedError()
  if (!reply.ok) throw reply
  return reply.value as T
}

/** Resource reads discard stale results while preserving real provider failures. */
export function readDevUtilityCommand<T>(
  fence: DevUtilityFence,
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): Promise<T | undefined> {
  return executeDevUtilityCommand<T>(fence, operation, body, resource).catch((error: unknown) => {
    if (!isDevUtilityContextChanged(error)) throw error
    return undefined
  })
}
