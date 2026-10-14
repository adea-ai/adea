import { buildDevCommand } from '../../browser/command'
import type { DevRuntimeService } from '../../platform'
import type { RuntimeSession, Scope } from '@adea-ai/types/dev-runtime'
import { executeChatCommand } from './commands'

/**
 * Session-authority gate for explicit handoff requests (#1177).
 *
 * The cloud admission path holds no session facts by design (no session
 * registry), so a bare session id can never prove binding, currency, or
 * control permission there. This gate runs first, through the existing
 * authenticated desktop/runtime command boundary — the same authority
 * that fences `dev.session.cancelHarness` — and mirrors its rules:
 * the session must exist, belong to the requesting scope, carry the
 * claimed task, be live, sit at the observed generation, and the caller
 * must hold session control (`dev.session.manage`). Anything else fails
 * closed here, before any admission post exists to poison or duplicate.
 *
 * Impure by necessity (it reads the host); the derivation in handoff.ts
 * stays pure. The generation returned is the host record's ACTUAL
 * current generation — callers must use it for the request, never a
 * possibly-stale transcript copy. This gate vets honest requests only: a
 * desktop-credentialed caller can bypass it, so the server treats every
 * retained claim as a request and coordination needs the effect boundary.
 */
export type HandoffSessionAuthorityPort = DevRuntimeService

export type HandoffSessionAuthority = Readonly<{
  runtimeSessionId: string
  taskId: string
  /** The host record's actual current generation. */
  generation: number
}>

const TERMINAL_LIFECYCLES: readonly string[] = ['completed', 'failed', 'cancelled']

export async function resolveHandoffSessionAuthority(
  service: HandoffSessionAuthorityPort,
  scope: Scope,
  input: Readonly<{
    runtimeSessionId: string
    taskId: string
    observedGeneration: number
  }>
): Promise<HandoffSessionAuthority> {
  const snapshot = await service.capabilitySnapshot(scope)
  if (!snapshot.granted.includes('dev.session.manage'))
    throw new Error('Handoff request unavailable: session control permission is not granted.')
  let record: RuntimeSession
  try {
    record = await executeChatCommand<RuntimeSession>(
      service,
      buildDevCommand({
        operation: 'dev.session.get',
        scope,
        body: { runtimeSessionId: input.runtimeSessionId },
        resource: {
          kind: 'runtime_session',
          id: input.runtimeSessionId,
          generation: input.observedGeneration,
        },
      })
    )
  } catch (error) {
    throw new Error(
      `Handoff request unavailable: the session authority refused the read (${describeRefusal(error)}).`,
      { cause: error }
    )
  }
  if (record.scope.workspaceId !== scope.workspaceId)
    throw new Error('Handoff request unavailable: the session belongs to another scope.')
  if ((record.taskId ?? undefined) !== input.taskId)
    throw new Error('Handoff request unavailable: the session is bound to another task.')
  if (record.archived || TERMINAL_LIFECYCLES.includes(record.lifecycle))
    throw new Error('Handoff request unavailable: the session is archived or ended.')
  if (record.generation !== input.observedGeneration)
    throw new Error(
      `Handoff request unavailable: the session advanced to generation ${record.generation}; refresh and retry.`
    )
  return {
    runtimeSessionId: record.id,
    taskId: record.taskId!,
    generation: record.generation,
  }
}

function describeRefusal(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return error instanceof Error ? error.message : 'unknown'
}
