import { expect, test } from 'bun:test'
import type { CurrentLeadTurnProduct } from '@adea-ai/db'
import { createLeadProductReaderHandler } from '../src/server/lead-product-reader'

// Negative checks for the v2 retained pins: a wrong principal and a stale revision. The predicates below
// are the reference a control-plane consumer must apply. Observation needs the same pins and a requester in
// allowedPrincipalIds. Cancellation also needs the requester to be the original admission actor. Nothing here
// authorises a prepare, dispatch, resume or publication, because a fenced body has none of those fields.

const cpWorkspaceId = 'wsp_0123456789ABCDEFGHJKMNPQRS'
const intentId = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7'
const actorUserId = '0f8b7c2e-1a2b-4c3d-8e9f-001122334455'
const otherUserId = '11111111-2222-4333-8444-555555555555'
const now = Date.UTC(2026, 9, 9, 12)
const servicePrincipal = 'svc_control-plane'
const admitted: CurrentLeadTurnProduct = {
  workspaceId: '5c1e2d3f-4a5b-4c6d-8e7f-998877665544',
  controlPlaneWorkspaceId: cpWorkspaceId,
  intentId,
  intentCreatedAt: new Date(now - 1000).toISOString(),
  channelId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  channelVersion: 2,
  channelVisibility: 'participants',
  audience: [`user:${actorUserId}`],
  messageId: '2b3c4d5e-6f70-4a81-9b92-a3b4c5d6e7f8',
  messageVersion: 1,
  actorUserId,
  agentId: '3c4d5e6f-7081-4b92-8ca3-b4c5d6e7f809',
  controlPlaneAgentId: 'agt_0123456789ABCDEFGHJKMNPQRS',
  profileId: 'profile-canonical',
  profileVersion: 'version-canonical',
  profileRevision: 1,
  prompt: 'Canonical message text',
  rollbackFence: null,
  dispatchPermitted: true,
}
const fenced: CurrentLeadTurnProduct = {
  ...admitted,
  rollbackFence: {
    fencedAt: new Date(now - 500).toISOString(),
    reason: 'rollback_cohort',
    actor: { kind: 'user', userId: actorUserId },
  },
  dispatchPermitted: false,
}
const url = 'https://adea.invalid/api/internal/pi-durable/lead-product/current'

/** The service proof binds one principal. Any other principal fails verification, as the real verifier does. */
const verifiesOnly = (principalId: string) => async (_r: Request, _w: string, requested: string) =>
  requested === principalId

function reader(options: {
  product?: CurrentLeadTurnProduct | undefined
  principal?: string
  clock?: number
  verify?: (request: Request, workspaceId: string, principalId: string) => Promise<boolean>
}) {
  const counts = { lookup: 0 }
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => options.clock ?? now,
    verify: options.verify ?? verifiesOnly(servicePrincipal),
    withCurrent: async (_w, _i, disclose) => {
      counts.lookup++
      return options.product === undefined ? undefined : disclose(options.product)
    },
  })
  return {
    counts,
    read: (principal = options.principal ?? servicePrincipal) =>
      handler(
        new Request(url, {
          method: 'POST',
          body: JSON.stringify({ workspaceId: cpWorkspaceId, intentId, principalId: principal }),
        })
      ),
  }
}

async function body(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

type RetainedPins = Readonly<{
  authorityRevision: number
  canonicalActorPrincipalId: string
  scopeRef: string
}>

/** Observation is allowed only when the retained pins match the current body and the requester is pinned. */
function observeAllowed(
  current: Record<string, unknown>,
  retained: RetainedPins,
  requester: string
) {
  return (
    current.schemaVersion === 'pi-lead-intent-fence/v2' &&
    current.dispatchPermitted === false &&
    current.authorityRevision === retained.authorityRevision &&
    current.canonicalActorPrincipalId === retained.canonicalActorPrincipalId &&
    current.scopeRef === retained.scopeRef &&
    Array.isArray(current.allowedPrincipalIds) &&
    current.allowedPrincipalIds.includes(requester)
  )
}

/** Cancellation also requires the requester to be the original admission actor, never the fence actor. */
function cancelAllowed(
  current: Record<string, unknown>,
  retained: RetainedPins,
  requester: string,
  requesterActor: string
) {
  return (
    observeAllowed(current, retained, requester) &&
    requesterActor === retained.canonicalActorPrincipalId
  )
}

test('wrong principal: a request whose principal the service proof does not bind gets no pins and no lookup', async () => {
  const { counts, read } = reader({ product: fenced, principal: 'svc_other' })
  expect(await body(await read())).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
  expect(counts.lookup).toBe(0)
})

test('wrong principal: the body names only the verified principal, so any other requester fails the reference predicate', async () => {
  const retained = await body(await reader({ product: fenced }).read())
  expect(retained.body.allowedPrincipalIds).toEqual([servicePrincipal])
  const pins = {
    authorityRevision: retained.body.authorityRevision as number,
    canonicalActorPrincipalId: retained.body.canonicalActorPrincipalId as string,
    scopeRef: retained.body.scopeRef as string,
  }
  expect(observeAllowed(retained.body, pins, servicePrincipal)).toBe(true)
  expect(observeAllowed(retained.body, pins, 'svc_other')).toBe(false)
  expect(cancelAllowed(retained.body, pins, 'svc_other', `user:${actorUserId}`)).toBe(false)
})

test('wrong actor: cancellation is bound to the original admission actor, and an operator fence never substitutes for it', async () => {
  const operatorFenced: CurrentLeadTurnProduct = {
    ...fenced,
    rollbackFence: {
      fencedAt: new Date(now - 500).toISOString(),
      reason: 'operator_intervention',
      actor: { kind: 'operator', operatorId: 'ops.rollback-1' },
    },
  }
  const current = (await body(await reader({ product: operatorFenced }).read())).body
  // The pins name the original admission actor, not the operator who fenced it.
  expect(current.canonicalActorPrincipalId).toBe(`user:${actorUserId}`)
  const pins = {
    authorityRevision: current.authorityRevision as number,
    canonicalActorPrincipalId: current.canonicalActorPrincipalId as string,
    scopeRef: current.scopeRef as string,
  }
  expect(cancelAllowed(current, pins, servicePrincipal, `user:${actorUserId}`)).toBe(true)
  expect(cancelAllowed(current, pins, servicePrincipal, `user:${otherUserId}`)).toBe(false)
  expect(cancelAllowed(current, pins, servicePrincipal, 'operator:ops.rollback-1')).toBe(false)
})

test('stale revision: a channel version bump after retention changes the authority revision, and the retained pins no longer match', async () => {
  const retainedBody = (await body(await reader({ product: fenced }).read())).body
  const retained: RetainedPins = {
    authorityRevision: retainedBody.authorityRevision as number,
    canonicalActorPrincipalId: retainedBody.canonicalActorPrincipalId as string,
    scopeRef: retainedBody.scopeRef as string,
  }
  const bumped = { ...fenced, channelVersion: fenced.channelVersion + 1 }
  const current = (await body(await reader({ product: bumped }).read())).body
  expect(current.authorityRevision).toBe(3)
  expect(observeAllowed(current, retained, servicePrincipal)).toBe(false)
  expect(cancelAllowed(current, retained, servicePrincipal, `user:${actorUserId}`)).toBe(false)
})

test('stale scope: an audience change after retention changes scopeRef, so the retained marker is refused for observation and cancel', async () => {
  const retainedBody = (await body(await reader({ product: fenced }).read())).body
  const retained: RetainedPins = {
    authorityRevision: retainedBody.authorityRevision as number,
    canonicalActorPrincipalId: retainedBody.canonicalActorPrincipalId as string,
    scopeRef: retainedBody.scopeRef as string,
  }
  const audienceChanged = {
    ...fenced,
    audience: [`user:${actorUserId}`, `user:${otherUserId}`],
  }
  const current = (await body(await reader({ product: audienceChanged }).read())).body
  expect(current.authorityRevision).toBe(retained.authorityRevision)
  expect(current.scopeRef).not.toBe(retained.scopeRef)
  expect(observeAllowed(current, retained, servicePrincipal)).toBe(false)
})

test('stale authority: a service proof revoked after the product read withholds the pins entirely', async () => {
  let checks = 0
  const { counts, read } = reader({
    product: fenced,
    verify: async () => {
      checks++
      return checks === 1
    },
  })
  expect(await body(await read())).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
  expect(counts.lookup).toBe(1)
})

test('current: unchanged authority gives identical pins on every read, so an unchanged marker still matches', async () => {
  const first = (await body(await reader({ product: fenced }).read())).body
  const second = (await body(await reader({ product: fenced }).read())).body
  expect(second).toEqual(first)
  const retained: RetainedPins = {
    authorityRevision: first.authorityRevision as number,
    canonicalActorPrincipalId: first.canonicalActorPrincipalId as string,
    scopeRef: first.scopeRef as string,
  }
  expect(observeAllowed(second, retained, servicePrincipal)).toBe(true)
  expect(cancelAllowed(second, retained, servicePrincipal, `user:${actorUserId}`)).toBe(true)
})
