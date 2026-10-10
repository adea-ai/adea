import { createHash } from 'node:crypto'
import type { CurrentLeadTurnProduct } from '@adea-ai/db'
import { canonicalJson, isRecord } from './control-plane-client'

export type LeadProductReaderDependencies = Readonly<{
  verify(request: Request, workspaceId: string, principalId: string): Promise<boolean>
  withCurrent(
    workspaceId: string,
    intentId: string,
    disclose: (product: CurrentLeadTurnProduct) => Promise<Response>
  ): Promise<Response | undefined>
  /** Explicit operator policy, never a credential grant or automatic renewal. */
  lifetimeMs: number
  now?: () => number
}>
const unavailable = () =>
  Response.json(
    { code: 'LEAD_PRODUCT_UNAVAILABLE' },
    {
      status: 404,
      headers: { 'cache-control': 'private, no-store' },
    }
  )
async function readSelectors(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return null
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > 4096) {
        await reader.cancel()
        return null
      }
      chunks.push(result.value)
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (
      !isRecord(data) ||
      Object.keys(data).toSorted().join(',') !== 'intentId,principalId,workspaceId' ||
      typeof data.workspaceId !== 'string' ||
      !/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(data.workspaceId) ||
      typeof data.intentId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        data.intentId
      ) ||
      typeof data.principalId !== 'string' ||
      !/^svc_[a-z][a-z0-9-]{0,59}$/.test(data.principalId)
    )
      return null
    return { workspaceId: data.workspaceId, intentId: data.intentId, principalId: data.principalId }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}
const fenceReasons: ReadonlySet<string> = new Set(['operator_intervention', 'rollback_cohort'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const operatorIdPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/
type FenceFacts = Readonly<{
  fencedAt: string
  reason: string
  actor: Readonly<{ kind: 'user'; userId: string } | { kind: 'operator'; operatorId: string }>
}>
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).toSorted().join(',') === [...keys].toSorted().join(',')

/**
 * Checks the fence envelope against dispatchPermitted before any response branch is chosen.
 * Returns null for a dispatchable, unfenced admission, the fence facts for a valid fenced one, and
 * undefined to refuse. Any shape that is neither refuses.
 */
function readFenceEnvelope(
  product: CurrentLeadTurnProduct,
  now: number
): FenceFacts | null | undefined {
  const fence: unknown = product.rollbackFence
  const dispatchPermitted: unknown = product.dispatchPermitted
  if (fence === null) return dispatchPermitted === true ? null : undefined
  if (!isRecord(fence) || dispatchPermitted !== false) return undefined
  if (!hasExactKeys(fence, ['actor', 'fencedAt', 'reason'])) return undefined
  const { fencedAt, reason, actor } = fence
  if (typeof fencedAt !== 'string' || typeof reason !== 'string' || !fenceReasons.has(reason))
    return undefined
  if (!isRecord(actor)) return undefined
  // Only the canonical UTC form the database emits, and never later than this verifier's clock.
  const at = Date.parse(fencedAt)
  if (!Number.isFinite(at) || at > now || new Date(at).toISOString() !== fencedAt) return undefined
  if (
    actor.kind === 'user' &&
    hasExactKeys(actor, ['kind', 'userId']) &&
    typeof actor.userId === 'string' &&
    uuidPattern.test(actor.userId)
  )
    return { fencedAt, reason, actor: { kind: 'user', userId: actor.userId } }
  if (
    actor.kind === 'operator' &&
    hasExactKeys(actor, ['kind', 'operatorId']) &&
    typeof actor.operatorId === 'string' &&
    operatorIdPattern.test(actor.operatorId)
  )
    return { fencedAt, reason, actor: { kind: 'operator', operatorId: actor.operatorId } }
  return undefined
}

/**
 * The product scope pin. It is computed the same way for an unfenced admission and for its fenced successor,
 * so a marker retained before the fence still matches the fenced body while the product state is unchanged.
 * It confers no CP spending or execution authority.
 */
function scopeRefFor(product: CurrentLeadTurnProduct): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        workspaceId: product.workspaceId,
        channelId: product.channelId,
        channelVersion: product.channelVersion,
        visibility: product.channelVisibility,
        audience: product.audience,
        messageId: product.messageId,
        messageVersion: product.messageVersion,
        actor: `user:${product.actorUserId}`,
        agentId: product.agentId,
        controlPlaneAgentId: product.controlPlaneAgentId,
        profileId: product.profileId,
        profileVersion: product.profileVersion,
        profileRevision: product.profileRevision,
        // #1232: a requested lead or child selection is part of the exact scope, so pins differ when it differs.
        ...(product.requestedModelSelections
          ? { requestedModelSelections: product.requestedModelSelections }
          : {}),
      })
    )
    .digest('hex')
  return `adea-product:sha256:${digest}`
}

/**
 * The v2 retained pins, read from the same canonical product that signed evidence uses. The original admission
 * actor is the cancel binding, not the fence actor. The principal is the one the service proof verified.
 */
function fencePins(product: CurrentLeadTurnProduct, verifiedPrincipalId: string) {
  return {
    authorityRevision: product.channelVersion,
    canonicalActorPrincipalId: `user:${product.actorUserId}`,
    scopeRef: scopeRefFor(product),
    allowedPrincipalIds: [verifiedPrincipalId],
  }
}

/** Authenticated private service read. The browser cannot supply actor, profile, selection or grants. */
export function createLeadProductReaderHandler(dependencies: LeadProductReaderDependencies) {
  return async (request: Request): Promise<Response> => {
    try {
      if (
        request.method !== 'POST' ||
        !Number.isSafeInteger(dependencies.lifetimeMs) ||
        dependencies.lifetimeMs < 60_000 ||
        dependencies.lifetimeMs > 300_000
      )
        return unavailable()
      const selectors = await readSelectors(request)
      if (
        !selectors ||
        !(await dependencies.verify(request, selectors.workspaceId, selectors.principalId))
      )
        return unavailable()
      const response = await dependencies.withCurrent(
        selectors.workspaceId,
        selectors.intentId,
        async (product) => {
          if (
            product.controlPlaneWorkspaceId !== selectors.workspaceId ||
            product.intentId !== selectors.intentId
          )
            return unavailable()
          // Canonical product locks remain held across final service verification and response construction.
          if (!(await dependencies.verify(request, selectors.workspaceId, selectors.principalId)))
            return unavailable()
          // Fail closed before any branch: a fence must be well formed, not from the future, and agree with
          // dispatchPermitted. A product with no fence is refused unless dispatch is explicitly permitted.
          const now = dependencies.now?.() ?? Date.now()
          const fence = readFenceEnvelope(product, now)
          if (fence === undefined) return unavailable()
          // A fenced admission is not admissible. The v2 body carries the requested identity, the validated fence
          // facts and the retained-pin fields that observe and actor-bound cancel need. It has no prompt, profile
          // or message content, so no prepare, dispatch, resume or publication can be built from it.
          if (fence) {
            const pins = fencePins(product, selectors.principalId)
            return Response.json(
              {
                schemaVersion: 'pi-lead-intent-fence/v2',
                intentId: selectors.intentId,
                workspaceId: selectors.workspaceId,
                dispatchPermitted: false,
                rollbackFence: fence,
                authorityRevision: pins.authorityRevision,
                canonicalActorPrincipalId: pins.canonicalActorPrincipalId,
                scopeRef: pins.scopeRef,
                allowedPrincipalIds: pins.allowedPrincipalIds,
              },
              { headers: { 'cache-control': 'private, no-store' } }
            )
          }
          const createdAt = Date.parse(product.intentCreatedAt)
          const expiresAt = createdAt + dependencies.lifetimeMs
          if (!Number.isFinite(createdAt) || createdAt > now || expiresAt <= now)
            return unavailable()
          const actor = `user:${product.actorUserId}`
          return Response.json(
            {
              schemaVersion: 'pi-lead-intent/v1',
              intentId: product.intentId,
              workspaceId: product.controlPlaneWorkspaceId,
              projectId: null,
              messageRef: `message:${product.messageId}`,
              authorityRevision: product.channelVersion,
              principalRef: actor,
              canonicalActorPrincipalId: actor,
              scopeRef: scopeRefFor(product),
              expiresAt: new Date(expiresAt).toISOString(),
              allowedPrincipalIds: [selectors.principalId],
              prompt: product.prompt,
              profileId: product.profileId,
              profileVersion: product.profileVersion,
              profileRevision: product.profileRevision,
              ...(product.requestedModelSelections
                ? { requestedModelSelections: product.requestedModelSelections }
                : {}),
            },
            { headers: { 'cache-control': 'private, no-store' } }
          )
        }
      )
      return response ?? unavailable()
    } catch {
      return unavailable()
    }
  }
}
