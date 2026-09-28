// Shared DevCommand construction. This module has no registry-wide imports so
// eager shell callers can bind only the generated operation metadata they use.
import type { DevCapability, DevCommand, DevOperation, Scope } from '@adea-ai/types/dev-runtime'

export type DevCommandBuildFields = {
  scope: Scope
  body: Record<string, unknown>
  /** Required exactly when the registry entry binds a resource. */
  resource?: { kind: string; id: string; generation: number }
  idempotencyKey?: string
}

export type BoundDevOperationMetadata = Readonly<{
  operation: DevOperation
  capabilities: readonly DevCapability[]
  resource: Readonly<{ kind: string; idField: string }> | null
}>

export type DevCommandBuildContext = Readonly<{
  now?: () => Date
  randomId?: () => string
  nonce?: () => string
}>

export function buildDevCommandFromMetadata(
  definition: BoundDevOperationMetadata,
  input: DevCommandBuildFields,
  context: DevCommandBuildContext = {}
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
  const capabilities = [...definition.capabilities]
  // The registry lists capabilities already in ascending code-point order;
  // sort defensively so the gate's exact-equality check can never trip on a
  // registry formatting change.
  capabilities.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  if (definition.resource && !input.resource)
    throw new Error(`operation ${definition.operation} requires a resource binding`)
  if (!definition.resource && input.resource)
    throw new Error(`operation ${definition.operation} does not bind a resource`)
  return {
    schemaVersion: 1,
    operation: definition.operation,
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
