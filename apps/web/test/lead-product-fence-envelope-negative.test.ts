import { expect, test } from 'bun:test'
import type { CurrentLeadTurnProduct } from '@adea-ai/db'
import { createLeadProductReaderHandler } from '../src/server/lead-product-reader'

// Negative checks against the real signed current-product handler, for missing, stale and mismatched
// fence envelopes. The envelope gate itself (dispatchPermitted, shape, reason, actor, fencedAt) is covered
// in lead-product-fence-envelope-gate.test.ts. The cases here must keep passing with the gate in place.

const cpWorkspaceId = 'wsp_0123456789ABCDEFGHJKMNPQRS'
const intentId = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7'
const actorUserId = '0f8b7c2e-1a2b-4c3d-8e9f-001122334455'
const now = Date.UTC(2026, 9, 10, 12)
const selectors = { workspaceId: cpWorkspaceId, intentId, principalId: 'svc_control-plane' }
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
const post = (body: unknown = selectors) =>
  new Request(url, { method: 'POST', body: JSON.stringify(body) })
const dispatchFields = [
  'prompt',
  'principalRef',
  'profileId',
  'profileVersion',
  'profileRevision',
  'expiresAt',
  'messageRef',
]
const denied = async (): Promise<never> => {
  throw new Error('Lead turn unavailable')
}

function run(options: {
  product?: CurrentLeadTurnProduct | (() => Promise<never>) | undefined
  clock?: number
  verify?: () => Promise<boolean>
}) {
  const counts = { verify: 0, lookup: 0 }
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => options.clock ?? now,
    verify: async () => {
      counts.verify++
      return options.verify ? options.verify() : true
    },
    withCurrent: async (_w, _i, disclose) => {
      counts.lookup++
      if (typeof options.product === 'function') return options.product()
      if (options.product === undefined) return undefined
      return disclose(options.product)
    },
  })
  return { handler, counts }
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('missing: no admission found is 404 with no body fields beyond the code', async () => {
  const { handler } = run({ product: undefined })
  expect(await json(await handler(post()))).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
})

test('missing: a denied lookup is 404 for an unfenced admission and for a fenced one, with no fence facts', async () => {
  expect(await json(await run({ product: denied }).handler(post()))).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
  const refused = await json(await run({ product: denied }).handler(post()))
  expect(refused.status).toBe(404)
  expect(refused.body).not.toHaveProperty('rollbackFence')
  expect(refused.body).not.toHaveProperty('dispatchPermitted')
})

test('missing: an absent service authority is refused before the product lookup runs', async () => {
  const { handler, counts } = run({ product: fenced, verify: async () => false })
  expect(await json(await handler(post()))).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
  expect(counts.lookup).toBe(0)
})

test('stale: service authority revoked after the product read withholds a fenced envelope', async () => {
  let checks = 0
  const { handler, counts } = run({
    product: fenced,
    verify: async () => {
      checks++
      return checks === 1
    },
  })
  const result = await json(await handler(post()))
  expect(result).toEqual({ status: 404, body: { code: 'LEAD_PRODUCT_UNAVAILABLE' } })
  expect(counts.lookup).toBe(1)
  expect(checks).toBe(2)
})

test('mismatched: a fenced envelope for another control-plane workspace is not emitted', async () => {
  const other = { ...fenced, controlPlaneWorkspaceId: `wsp_${'A'.repeat(26)}` }
  const { handler } = run({ product: other })
  const result = await json(await handler(post()))
  expect(result).toEqual({ status: 404, body: { code: 'LEAD_PRODUCT_UNAVAILABLE' } })
})

test('mismatched: a fenced envelope for another intent is not emitted', async () => {
  const other = { ...fenced, intentId: '11111111-2222-4333-8444-555555555555' }
  const { handler } = run({ product: other })
  const result = await json(await handler(post()))
  expect(result).toEqual({ status: 404, body: { code: 'LEAD_PRODUCT_UNAVAILABLE' } })
})

test('mismatched: selectors that carry envelope or admission fields are refused before any lookup', async () => {
  for (const extra of [
    { rollbackFence: fenced.rollbackFence },
    { dispatchPermitted: true },
    { prompt: 'injected' },
    { canonicalActorPrincipalId: `user:${actorUserId}` },
  ]) {
    const { handler, counts } = run({ product: fenced })
    expect(await json(await handler(post({ ...selectors, ...extra })))).toEqual({
      status: 404,
      body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
    })
    expect(counts.lookup).toBe(0)
  }
})

test('stale: an admission past its lifetime is refused, while a fenced envelope past it carries no dispatch fields', async () => {
  const expiredClock = Date.parse(admitted.intentCreatedAt) + 300_000
  const unfenced = run({ product: admitted, clock: expiredClock })
  expect(await json(await unfenced.handler(post()))).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
  const fencedLater = run({ product: fenced, clock: expiredClock })
  const result = await json(await fencedLater.handler(post()))
  expect(result.status).toBe(200)
  expect(result.body.schemaVersion).toBe('pi-lead-intent-fence/v1')
  for (const field of dispatchFields) expect(result.body).not.toHaveProperty(field)
})

test('stale: an admission created after the clock is refused', async () => {
  const future = { ...admitted, intentCreatedAt: new Date(now + 60_000).toISOString() }
  const { handler } = run({ product: future })
  expect(await json(await handler(post()))).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
})

test('malformed request: a non-POST or an oversized body is refused before any lookup', async () => {
  const get = run({ product: fenced })
  expect((await get.handler(new Request(url, { method: 'GET' }))).status).toBe(404)
  expect(get.counts.lookup).toBe(0)
  const oversized = run({ product: fenced })
  expect((await oversized.handler(post({ ...selectors, padding: 'a'.repeat(4096) }))).status).toBe(
    404
  )
  expect(oversized.counts.lookup).toBe(0)
})
