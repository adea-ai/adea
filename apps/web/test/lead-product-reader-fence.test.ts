import { expect, test } from 'bun:test'
import type { CurrentLeadTurnProduct } from '@adea-ai/db'
import { createLeadProductReaderHandler } from '../src/server/lead-product-reader'

// M18.01.3: a fenced admission is not admissible through the signed current product reader. It
// returns fence facts only, with no prompt, profile, scope or principal, so CP cannot build a dispatch
// from it even before CP enforces the fence itself.

const workspaceId = `wsp_${'0'.repeat(26)}`
const intentId = crypto.randomUUID()
const actorUserId = crypto.randomUUID()
const now = Date.UTC(2026, 9, 8, 12)
const selectors = { workspaceId, intentId, principalId: 'svc_control-plane' }
const request = () =>
  new Request('https://adea.invalid/api/internal/pi-durable/lead-product/current', {
    method: 'POST',
    body: JSON.stringify(selectors),
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
  rollbackFence: null,
  dispatchPermitted: true,
}
const fenced: CurrentLeadTurnProduct = {
  ...product,
  rollbackFence: {
    fencedAt: new Date(now - 500).toISOString(),
    reason: 'rollback_cohort',
    actor: { kind: 'user', userId: actorUserId },
  },
  dispatchPermitted: false,
}
const handler = (current: CurrentLeadTurnProduct) =>
  createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => now,
    verify: async () => true,
    withCurrent: async (_w, _i, disclose) => disclose(current),
  })

test('a fenced admission returns fence facts only and no dispatchable admission fields', async () => {
  const response = await handler(fenced)(request())
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const body = (await response.json()) as Record<string, unknown>
  expect(Object.keys(body).toSorted()).toEqual([
    'dispatchPermitted',
    'intentId',
    'rollbackFence',
    'schemaVersion',
    'workspaceId',
  ])
  expect(body).toEqual({
    schemaVersion: 'pi-lead-intent-fence/v1',
    intentId,
    workspaceId,
    dispatchPermitted: false,
    rollbackFence: fenced.rollbackFence,
  })
  for (const field of ['prompt', 'scopeRef', 'principalRef', 'allowedPrincipalIds', 'profileId'])
    expect(body).not.toHaveProperty(field)
})

test('an unfenced admission keeps the exact v1 admission shape and permits dispatch', async () => {
  const response = await handler(product)(request())
  expect(response.status).toBe(200)
  const body = (await response.json()) as Record<string, unknown>
  expect(body.schemaVersion).toBe('pi-lead-intent/v1')
  expect(body.prompt).toBe(product.prompt)
  expect(body).not.toHaveProperty('rollbackFence')
  expect(body).not.toHaveProperty('dispatchPermitted')
})
