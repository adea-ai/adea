import type { DevOperation } from '@adea-ai/types/dev-runtime'

import { buildDevCommand } from './browser/command'
import {
  DevUtilityContextChangedError,
  DevUtilityContextUnavailableError,
  isDevUtilityContextChanged,
  type DevUtilityFence,
} from './utility-context'

/** Execute under the captured identity and fail closed if it changes in flight. */
export async function executeDevUtilityCommand<T>(
  fence: DevUtilityFence | undefined,
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): Promise<T> {
  if (!fence || !fence.context.scope) throw new DevUtilityContextUnavailableError()
  if (!fence.isCurrent()) throw new DevUtilityContextChangedError()
  const reply = await fence.context.runtime.execute(
    buildDevCommand({
      operation,
      scope: fence.context.scope,
      body,
      ...(resource ? { resource } : {}),
    })
  )
  if (!fence.isCurrent()) throw new DevUtilityContextChangedError()
  if (!reply.ok) throw reply
  return reply.value as T
}

/** Resource reads discard stale results while preserving real provider failures. */
export async function readDevUtilityCommand<T>(
  fence: DevUtilityFence,
  operation: DevOperation,
  body: Record<string, unknown>,
  resource?: { kind: string; id: string; generation: number }
): Promise<T | undefined> {
  try {
    return await executeDevUtilityCommand<T>(fence, operation, body, resource)
  } catch (error) {
    if (isDevUtilityContextChanged(error)) return undefined
    throw error
  }
}
