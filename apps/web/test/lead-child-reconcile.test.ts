import { expect, test } from 'bun:test'
import { createLeadChildReconcileHandler } from '../src/server/lead-child-reconcile'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const principalId = 'svc_product-reader'
const selectors = { workspaceId, intentId, principalId }
const request = (body: unknown = selectors) =>
  new Request('https://adea.example/api/internal/pi-durable/child-receipt/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('signed retained-event wake resolves canonical actor and publishes with no caller outcome', async () => {
  let checks = 0
  const published: unknown[] = []
  const handler = createLeadChildReconcileHandler({
    verify: async () => {
      checks++
      return true
    },
    current: async () => ({ workspaceId: 'adea-workspace', intentId, userId: 'original-actor' }),
    publish: async (scope) => {
      published.push(scope)
    },
  })
  expect((await handler(request())).status).toBe(204)
  expect(checks).toBe(2)
  expect(published).toEqual([{ workspaceId: 'adea-workspace', intentId, userId: 'original-actor' }])
})

test('untrusted selectors, revoked proof and a changed current intent cannot invoke publication', async () => {
  for (const body of [
    { ...selectors, resultRef: 'art_forged' },
    { ...selectors, userId: 'other' },
    { ...selectors, principalId: 'user:other' },
  ]) {
    let publishes = 0
    const handler = createLeadChildReconcileHandler({
      verify: async () => true,
      current: async () => ({ workspaceId: 'adea-workspace', intentId, userId: 'actor' }),
      publish: async () => {
        publishes++
      },
    })
    expect((await handler(request(body))).status).toBe(404)
    expect(publishes).toBe(0)
  }
  for (const mode of ['revoked', 'changed'] as const) {
    let checks = 0
    let publishes = 0
    const handler = createLeadChildReconcileHandler({
      verify: async () => mode === 'changed' || ++checks === 1,
      current: async () => ({
        workspaceId: 'adea-workspace',
        intentId: mode === 'changed' ? crypto.randomUUID() : intentId,
        userId: 'actor',
      }),
      publish: async () => {
        publishes++
      },
    })
    expect((await handler(request())).status).toBe(404)
    expect(publishes).toBe(0)
  }
})

test('publication failure is a bounded retryable refusal', async () => {
  const handler = createLeadChildReconcileHandler({
    verify: async () => true,
    current: async () => ({ workspaceId: 'adea-workspace', intentId, userId: 'actor' }),
    publish: async () => {
      throw new Error('private database or CP detail')
    },
  })
  const response = await handler(request())
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('private database')
})

test('credential verifier failure discloses no private error and never publishes', async () => {
  let publishes = 0
  const handler = createLeadChildReconcileHandler({
    verify: async () => {
      throw new Error('private trust failure')
    },
    current: async () => undefined,
    publish: async () => {
      publishes++
    },
  })
  const response = await handler(request())
  expect(response.status).toBe(404)
  expect(await response.text()).not.toContain('private trust')
  expect(publishes).toBe(0)
})
