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

/**
 * The signed bytes for every node-initiated delivery request. The purpose is part
 * of the message, so a signature made for one purpose never verifies for another.
 * Optional trailing fields bind a body digest; the pull message has none.
 */
function runtimeNodeDeliveryMessage(
  scope: RuntimeNodeDeliveryScope,
  input: Omit<RuntimeNodePullRequest, 'signature'>,
  purpose: 'commands.pull' | typeof RUNTIME_NODE_RETENTION_RECEIPT_PURPOSE,
  bodyDigest?: string
): string {
  if (!uuid.test(scope.workspaceId) || !uuid.test(scope.runtimeNodeId))
    throw new Error('Invalid delivery scope')
  return JSON.stringify([
    'adea-runtime-node-delivery',
    input.version,
    purpose,
    scope.workspaceId,
    scope.runtimeNodeId,
    input.keyId,
    input.nonce,
    input.issuedAt,
    ...(bodyDigest === undefined ? [] : [bodyDigest]),
  ])
}

export function runtimeNodePullMessage(
  scope: RuntimeNodeDeliveryScope,
  input: Omit<RuntimeNodePullRequest, 'signature'>
): string {
  return runtimeNodeDeliveryMessage(scope, input, 'commands.pull')
}

/** Node-to-cloud purpose for trusted cleanup receipts (#1221). */
export const RUNTIME_NODE_RETENTION_RECEIPT_PURPOSE = 'retention.cleanup_receipt' as const

/** The receipt body a node signs with its active signing key. */
export type RuntimeNodeRetentionReceiptRequest = Readonly<{
  envelope: RuntimeNodePullRequest
  category: string
  receipt: Readonly<{
    coverage: string
    observedAt: string
    operation: string
    outcome: string
    requestId: string
    residualCount: number
    subjectId: string
  }>
}>

const receiptKeys = 'coverage,observedAt,operation,outcome,requestId,residualCount,subjectId'
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/**
 * Parse the body with an exact key set. Enum meaning and identity rules are
 * enforced by the retention gate, which refuses what it does not recognize.
 */
export function parseRuntimeNodeRetentionReceiptRequest(
  value: unknown
): RuntimeNodeRetentionReceiptRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).toSorted().join(',') !== 'category,envelope,receipt') return null
  const envelope = parseRuntimeNodePullRequest(body.envelope)
  if (!envelope || typeof body.category !== 'string' || !opaque.test(body.category)) return null
  const receipt = body.receipt as Record<string, unknown> | null
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null
  if (Object.keys(receipt).toSorted().join(',') !== receiptKeys) return null
  const { coverage, observedAt, operation, outcome, requestId, residualCount, subjectId } = receipt
  if (
    typeof coverage !== 'string' ||
    typeof operation !== 'string' ||
    typeof outcome !== 'string' ||
    typeof observedAt !== 'string' ||
    typeof requestId !== 'string' ||
    typeof subjectId !== 'string' ||
    !opaque.test(coverage) ||
    !opaque.test(operation) ||
    !opaque.test(outcome) ||
    !opaque.test(requestId) ||
    !opaque.test(subjectId) ||
    !Number.isSafeInteger(residualCount) ||
    (residualCount as number) < 0 ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt
  )
    return null
  return Object.freeze({
    envelope,
    category: body.category,
    receipt: Object.freeze({
      coverage,
      observedAt,
      operation,
      outcome,
      requestId,
      residualCount: residualCount as number,
      subjectId,
    }),
  })
}

/**
 * SHA-256 over a fixed-order serialization of the category and receipt. Signing
 * the digest binds the whole body, so a relayed receipt cannot be re-labelled.
 */
export async function runtimeNodeRetentionReceiptDigest(
  body: Pick<RuntimeNodeRetentionReceiptRequest, 'category' | 'receipt'>
): Promise<string> {
  const { coverage, observedAt, operation, outcome, requestId, residualCount, subjectId } =
    body.receipt
  const canonical = JSON.stringify([
    'adea-runtime-node-retention-receipt',
    body.category,
    coverage,
    observedAt,
    operation,
    outcome,
    requestId,
    residualCount,
    subjectId,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Buffer.from(digest).toString('base64url')
}

export async function runtimeNodeRetentionReceiptMessage(
  scope: RuntimeNodeDeliveryScope,
  body: RuntimeNodeRetentionReceiptRequest
): Promise<string> {
  return runtimeNodeDeliveryMessage(
    scope,
    body.envelope,
    RUNTIME_NODE_RETENTION_RECEIPT_PURPOSE,
    await runtimeNodeRetentionReceiptDigest(body)
  )
}

/** WebCrypto Ed25519 verification of a signed receipt body, as for pulls. */
export async function verifyRuntimeNodeRetentionReceipt(
  scope: RuntimeNodeDeliveryScope,
  body: RuntimeNodeRetentionReceiptRequest,
  publicKey: string
): Promise<boolean> {
  const bytes = decode(publicKey, 32)
  if (!bytes) return false
  try {
    const key = await crypto.subtle.importKey('raw', bytes as BufferSource, 'Ed25519', false, [
      'verify',
    ])
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      decode(body.envelope.signature, 64)! as BufferSource,
      new TextEncoder().encode(await runtimeNodeRetentionReceiptMessage(scope, body))
    )
  } catch {
    return false
  }
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
