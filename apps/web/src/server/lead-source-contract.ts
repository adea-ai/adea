import { createHash } from 'node:crypto'
import type { CurrentSourceLeadTurnProduct } from '@adea-ai/db'
import { canonicalJson, isRecord } from './control-plane-client'

type ContextIdentity = Readonly<{
  host: Readonly<{ workspaceId: string; productWorkspaceId: string; conversationId: string }>
  source: Readonly<{
    workspaceId: string
    productWorkspaceId: string
    agentId: string
    productAgentId: string
  }>
}>
/** Actual candidate shared-contract exports, supplied by the server composition.
 * Missing released SDK support cannot be replaced with handwritten schemas.
 */
export type SourceLeadContracts = Readonly<{
  piLeadConversationAgentContextRef(input: ContextIdentity): string
  PiLeadHostSourceAuthoritySchema: Readonly<{ parse(input: unknown): unknown }>
  PiLeadSourcePublicationSchema: Readonly<{ parse(input: unknown): unknown }>
}>
type Options = Readonly<{ contracts: SourceLeadContracts; lifetimeMs: number; now: number }>
export type SourceLeadRetainedPins = Readonly<{
  intentId: string
  executionId: string
  attemptId: string
  runtimeSessionId: string
  dispatchId: string
  preparationRef: string
  profileVersionId: string
  profileContentDigest: string
  selectionRef: string
  selectionRevision: number
}>
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`

/** Project only the locked canonical source-reader product. This is not a
 * service/principal/grant authorization decision and is not wired to HTTP.
 * The caller must keep host/source authority through final service verification.
 */
export function sourceLeadProductSnapshot(product: CurrentSourceLeadTurnProduct, options: Options) {
  const createdAt = Date.parse(product.intentCreatedAt)
  const expiresAt = createdAt + options.lifetimeMs
  if (
    typeof options.contracts?.piLeadConversationAgentContextRef !== 'function' ||
    typeof options.contracts?.PiLeadHostSourceAuthoritySchema?.parse !== 'function' ||
    !Number.isSafeInteger(options.lifetimeMs) ||
    options.lifetimeMs < 60_000 ||
    options.lifetimeMs > 300_000 ||
    !Number.isFinite(options.now) ||
    !Number.isFinite(createdAt) ||
    createdAt > options.now ||
    expiresAt <= options.now
  )
    throw new Error('LEAD_SOURCE_PRODUCT_UNAVAILABLE')
  const host = {
    workspaceId: product.controlPlaneWorkspaceId,
    productWorkspaceId: product.workspaceId,
    conversationId: product.channelId,
    conversationVersion: product.channelVersion,
    messageId: product.messageId,
    messageVersion: product.messageVersion,
    canonicalActorPrincipalId: `user:${product.actorUserId}`,
    audienceDigest: digest(product.audience),
    enlistmentGrantId: product.enlistmentGrantId,
    enlistmentRevision: product.enlistmentRevision,
  }
  const source = {
    workspaceId: product.sourceControlPlaneWorkspaceId,
    productWorkspaceId: product.agentWorkspaceId,
    agentId: product.controlPlaneAgentId,
    productAgentId: product.agentId,
    profileId: product.profileId,
    profileVersion: product.profileVersion,
    profileRevision: product.profileRevision,
  }
  const authority = {
    schemaVersion: 'pi-lead-host-source-authority/v1' as const,
    intentId: product.intentId,
    host,
    source,
    contextRef: options.contracts.piLeadConversationAgentContextRef({ host, source }),
  }
  const parsed = options.contracts.PiLeadHostSourceAuthoritySchema.parse(authority)
  if (canonicalJson(parsed) !== canonicalJson(authority))
    throw new Error('LEAD_SOURCE_PRODUCT_UNAVAILABLE')
  return {
    authority,
    prompt: product.prompt,
    expiresAt: new Date(expiresAt).toISOString(),
    ...(product.requestedModelSelections
      ? { requestedModelSelections: product.requestedModelSelections }
      : {}),
  }
}

/** Exact delivery comparison, to be called inside the canonical source/host
 * publication transaction. This helper creates no grant or publication effect.
 * Source CP authority must be independently verified by the trusted adapter.
 */
export function isSourceLeadPublicationCurrent(
  product: CurrentSourceLeadTurnProduct,
  pins: SourceLeadRetainedPins,
  raw: unknown,
  bodyText: string,
  options: Options
): boolean {
  try {
    if (
      typeof options.contracts?.PiLeadSourcePublicationSchema?.parse !== 'function' ||
      !bodyText.trim() ||
      bodyText.length > 100_000
    )
      return false
    const proof = options.contracts.PiLeadSourcePublicationSchema.parse(raw)
    if (!isRecord(proof) || !isRecord(proof.binding) || !isRecord(proof.publication)) return false
    const binding = proof.binding
    const publication = proof.publication
    const expected = sourceLeadProductSnapshot(product, options)
    if (
      pins.intentId !== product.intentId ||
      canonicalJson(binding.authority) !== canonicalJson(expected.authority) ||
      binding.intentExpiresAt !== expected.expiresAt ||
      publication.workspaceId !== product.sourceControlPlaneWorkspaceId ||
      publication.intentId !== pins.intentId ||
      publication.dispatchId !== pins.dispatchId ||
      publication.preparationRef !== pins.preparationRef ||
      publication.canonicalActorPrincipalId !== expected.authority.host.canonicalActorPrincipalId ||
      binding.profileVersionId !== pins.profileVersionId ||
      binding.profileContentDigest !== pins.profileContentDigest
    )
      return false
    for (const key of [
      'executionId',
      'attemptId',
      'runtimeSessionId',
      'selectionRef',
      'selectionRevision',
    ] as const) {
      if (binding[key] !== pins[key] || publication[key] !== pins[key]) return false
    }
    const expiry =
      typeof publication.expiresAt === 'string' ? Date.parse(publication.expiresAt) : NaN
    return (
      Number.isFinite(expiry) &&
      expiry > options.now &&
      expiry <= options.now + 30_000 &&
      expiry <= Date.parse(expected.expiresAt) &&
      publication.resultContentDigest ===
        `sha256:${createHash('sha256').update(bodyText, 'utf8').digest('hex')}`
    )
  } catch {
    return false
  }
}
