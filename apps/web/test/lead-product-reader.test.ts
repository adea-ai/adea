import { expect, test } from 'bun:test'
import type { CurrentLeadTurnProduct } from '@adea-ai/db'
import { createLeadProductReaderHandler } from '../src/server/lead-product-reader'
const workspaceId = `wsp_${'0'.repeat(26)}`
const intentId = crypto.randomUUID()
const actorUserId = crypto.randomUUID()
const now = Date.UTC(2026, 9, 8, 12)
const selectors = { workspaceId, intentId, principalId: 'svc_control-plane' }
const request = (body: unknown = selectors) =>
  new Request('https://adea.invalid/api/internal/pi-durable/lead-product/current', {
    method: 'POST',
    body: JSON.stringify(body),
  })
const product: CurrentLeadTurnProduct = {
  workspaceId: crypto.randomUUID(),
  controlPlaneWorkspaceId: workspaceId,
  intentId,
  intentCreatedAt: new Date(now - 1_000).toISOString(),
  channelId: crypto.randomUUID(),
  channelVersion: 2,
  channelVisibility: 'participants',
  audience: [actorUserId],
  messageId: crypto.randomUUID(),
  messageVersion: 1,
  actorUserId,
  agentId: crypto.randomUUID(),
  controlPlaneAgentId: `agt_${'0'.repeat(26)}`,
  profileId: 'profile-canonical',
  profileVersion: 'version-canonical',
  profileRevision: 1,
  prompt: 'Canonical message text',
}
test('private product read authenticates before DB work and rejects caller actor/model/profile assertions', async () => {
  let reads = 0
  const dependencies = {
    lifetimeMs: 300_000,
    now: () => now,
    verify: async () => false,
    withCurrent: async (
      _w: string,
      _i: string,
      disclose: (p: CurrentLeadTurnProduct) => Promise<Response>
    ) => {
      reads++
      return disclose(product)
    },
  }
  expect((await createLeadProductReaderHandler(dependencies)(request())).status).toBe(404)
  expect(reads).toBe(0)
  const handler = createLeadProductReaderHandler({ ...dependencies, verify: async () => true })
  for (const field of ['canonicalActorPrincipalId', 'selectionRef', 'profileId', 'schemaVersion'])
    expect((await handler(request({ ...selectors, [field]: 'caller-assertion' }))).status).toBe(404)
  expect(reads).toBe(0)
  expect((await handler(request({ ...selectors, workspaceId: 'not-a-workspace' }))).status).toBe(
    404
  )
})
test('fresh canonical evidence pins original actor/audience/profile and has a stable bounded intent expiry', async () => {
  let clock = now
  let current: CurrentLeadTurnProduct | undefined = product
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => clock,
    verify: async () => true,
    withCurrent: async (_w, _i, disclose) => (current ? disclose(current) : undefined),
  })
  const first = await handler(request())
  expect(first.status).toBe(200)
  expect(first.headers.get('cache-control')).toBe('private, no-store')
  const evidence = await first.json()
  expect(evidence.canonicalActorPrincipalId).toBe(`user:${actorUserId}`)
  expect(evidence.principalRef).toBe(`user:${actorUserId}`)
  expect(evidence.allowedPrincipalIds).toEqual(['svc_control-plane'])
  expect(evidence).not.toHaveProperty('selectionRef')
  expect(evidence).not.toHaveProperty('profileContentDigest')
  expect(evidence.profileId).toBe(product.profileId)
  expect(evidence.profileVersion).toBe(product.profileVersion)
  clock += 1_000
  expect(await (await handler(request())).json()).toEqual(evidence)
  current = { ...product, audience: [...product.audience, crypto.randomUUID()] }
  expect((await (await handler(request())).json()).scopeRef).not.toBe(evidence.scopeRef)
  current = undefined // current DB authority denies a revoked/archived actor or audience
  expect((await handler(request())).status).toBe(404)
  current = product
  clock = now + 300_000
  expect((await handler(request())).status).toBe(404)
})
test('invalid policy, body limit, wrong DB binding and DB denial expose no canonical text', async () => {
  const dependencies = {
    lifetimeMs: 0,
    now: () => now,
    verify: async () => true,
    withCurrent: async (
      _w: string,
      _i: string,
      disclose: (p: CurrentLeadTurnProduct) => Promise<Response>
    ) => disclose(product),
  }
  expect((await createLeadProductReaderHandler(dependencies)(request())).status).toBe(404)
  const handler = createLeadProductReaderHandler({ ...dependencies, lifetimeMs: 300_000 })
  expect((await handler(request({ ...selectors, padding: 'a'.repeat(4096) }))).status).toBe(404)
  const denied = createLeadProductReaderHandler({
    ...dependencies,
    lifetimeMs: 300_000,
    withCurrent: async () => {
      throw new Error('provider or canonical text must never escape')
    },
  })
  const response = await denied(request())
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ code: 'LEAD_PRODUCT_UNAVAILABLE' })
  const mismatched = createLeadProductReaderHandler({
    ...dependencies,
    lifetimeMs: 300_000,
    withCurrent: async (_w, _i, disclose) =>
      disclose({ ...product, controlPlaneWorkspaceId: `wsp_${'1'.repeat(26)}` }),
  })
  expect((await mismatched(request())).status).toBe(404)
})

test('service revocation while the canonical DB read awaits withholds the private prompt', async () => {
  let currentServiceAuthority = true
  let release!: (value: CurrentLeadTurnProduct) => void
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  const pending = new Promise<CurrentLeadTurnProduct>((resolve) => {
    release = resolve
  })
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => now,
    verify: async () => currentServiceAuthority,
    withCurrent: async (_w, _i, disclose) => {
      began()
      return disclose(await pending)
    },
  })
  const result = handler(request())
  await started
  currentServiceAuthority = false
  release(product)
  const response = await result
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ code: 'LEAD_PRODUCT_UNAVAILABLE' })
})

test('final service verification and response construction remain inside canonical product locks', async () => {
  let locked = false
  let calls = 0
  let begin!: () => void
  let release!: () => void
  const verifying = new Promise<void>((resolve) => {
    begin = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => now,
    verify: async () => {
      if (++calls === 2) {
        expect(locked).toBe(true)
        begin()
        await gate
        expect(locked).toBe(true)
      }
      return true
    },
    withCurrent: async (_w, _i, disclose) => {
      locked = true
      try {
        return await disclose(product)
      } finally {
        locked = false
      }
    },
  })
  const pending = handler(request())
  await verifying
  expect(locked).toBe(true) // a concurrent product revocation must await these locks
  release()
  const response = await pending
  expect(response.status).toBe(200)
  expect(locked).toBe(false)
})
