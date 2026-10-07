/** Narrow outbound node transport: this signature grants no user/session authority. */
export type RuntimeNodePullRequest = Readonly<{
  version: 1
  keyId: string
  nonce: string
  issuedAt: string
  signature: string
}>
export type RuntimeNodeDeliveryScope = Readonly<{ workspaceId: string; runtimeNodeId: string }>
export const RUNTIME_NODE_PULL_WINDOW_MS = 120_000
export const RUNTIME_NODE_PULL_FUTURE_MS = 30_000
export const RUNTIME_NODE_PULLS_PER_MINUTE = 60
export type RuntimeNodeCommandDelivery = Readonly<{
  version: 1
  commandId: string
  submissionId: string
  taskId: string
  agentId: string
  runtimeNodeId: string
  requestId: string
  taskVersion: number
  profile: Readonly<{ id: string; version: string; revision: number }>
  controlPlane: Readonly<{
    workspaceId: string
    projectId: string
    taskId: string
    agentId: string
    runtimeNodeRefId: string
  }>
  conversation: Readonly<{
    channelId: string | null
    messageId: string | null
    threadRootMessageId: string | null
  }>
  objectiveContentRefId: string | null
  envelope: unknown
}>

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
function decode(value: unknown, size: number): Uint8Array | null {
  if (
    typeof value !== 'string' ||
    value.length !== Math.ceil((size * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return null
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    if (
      binary.length !== size ||
      btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') !== value
    )
      return null
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

export function parseRuntimeNodePullRequest(value: unknown): RuntimeNodePullRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).toSorted().join(',') !== 'issuedAt,keyId,nonce,signature,version' ||
    input.version !== 1 ||
    typeof input.keyId !== 'string' ||
    !uuid.test(input.keyId) ||
    typeof input.nonce !== 'string' ||
    !uuid.test(input.nonce) ||
    typeof input.issuedAt !== 'string' ||
    input.issuedAt.length !== 24 ||
    !Number.isFinite(Date.parse(input.issuedAt)) ||
    new Date(input.issuedAt).toISOString() !== input.issuedAt ||
    !decode(input.signature, 64)
  )
    return null
  return Object.freeze({
    version: 1,
    keyId: input.keyId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    signature: input.signature as string,
  })
}

export function runtimeNodePullMessage(
  scope: RuntimeNodeDeliveryScope,
  input: Omit<RuntimeNodePullRequest, 'signature'>
): string {
  if (!uuid.test(scope.workspaceId) || !uuid.test(scope.runtimeNodeId))
    throw new Error('Invalid delivery scope')
  return JSON.stringify([
    'adea-runtime-node-delivery',
    input.version,
    'commands.pull',
    scope.workspaceId,
    scope.runtimeNodeId,
    input.keyId,
    input.nonce,
    input.issuedAt,
  ])
}

/** WebCrypto only; no home-grown signature primitive or private-key persistence. */
export async function verifyRuntimeNodePull(
  scope: RuntimeNodeDeliveryScope,
  input: RuntimeNodePullRequest,
  publicKey: string
): Promise<boolean> {
  const parsed = parseRuntimeNodePullRequest(input)
  const bytes = decode(publicKey, 32)
  if (!parsed || !bytes) return false
  try {
    const key = await crypto.subtle.importKey('raw', bytes as BufferSource, 'Ed25519', false, [
      'verify',
    ])
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      decode(parsed.signature, 64)! as BufferSource,
      new TextEncoder().encode(runtimeNodePullMessage(scope, parsed))
    )
  } catch {
    return false
  }
}
