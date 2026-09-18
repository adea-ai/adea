// Client-side DevCommand construction for the browser/devices panes.
// Capabilities are copied from the generated registry (code-point order),
// nonces come from a cryptographic RNG, and every command carries the
// 60-second expiry the M10 gate enforces.
import type { DevCapability, DevCommand, DevOperation, Scope } from '@adea-ai/types/dev-runtime'
import { devOperationDefinitions } from '@adea-ai/types/dev-runtime'

export type BuildDevCommandInput = {
  operation: DevOperation
  scope: Scope
  body: Record<string, unknown>
  /** Required exactly when the registry entry binds a resource. */
  resource?: { kind: string; id: string; generation: number }
  idempotencyKey?: string
}

export function buildDevCommand(
  input: BuildDevCommandInput,
  context: Readonly<{ now?: () => Date; randomId?: () => string; nonce?: () => string }> = {}
): DevCommand {
  const now = context.now ?? (() => new Date())
  const randomId = context.randomId ?? (() => crypto.randomUUID())
  const nonce =
    context.nonce ??
    (() => {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    })
  const issuedAt = now()
  const definition = devOperationDefinitions[input.operation]
  const capabilities = [...definition.capabilities] as DevCapability[]
  // The registry lists capabilities already in ascending code-point order;
  // sort defensively so the gate's exact-equality check can never trip on a
  // registry formatting change.
  capabilities.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  if (definition.resource && !input.resource)
    throw new Error(`operation ${input.operation} requires a resource binding`)
  if (!definition.resource && input.resource)
    throw new Error(`operation ${input.operation} does not bind a resource`)
  return {
    schemaVersion: 1,
    operation: input.operation,
    requestId: randomId(),
    nonce: nonce(),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
    scope: input.scope,
    capabilities,
    ...(input.resource ? { resource: input.resource } : {}),
    body: input.body,
  }
}
