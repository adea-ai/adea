import { expect, test } from 'bun:test'
import type { CurrentLeadTurnProduct } from '@adea-ai/db'
import { createLeadProductReaderHandler } from '../src/server/lead-product-reader'

// Focused negative route tests for the fence envelope gate in the signed current-product reader. A product
// with dispatchPermitted false needs a valid fence, and a fence must be well formed, not from the future,
// and agree with dispatchPermitted. Every refusal is the same unavailable answer, with no fence facts.

const cpWorkspaceId = 'wsp_0123456789ABCDEFGHJKMNPQRS'
const intentId = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7'
const actorUserId = '0f8b7c2e-1a2b-4c3d-8e9f-001122334455'
const now = Date.UTC(2026, 9, 10, 12)
const selectors = { workspaceId: cpWorkspaceId, intentId, principalId: 'svc_control-plane' }
const unavailableBody = { status: 404, body: { code: 'LEAD_PRODUCT_UNAVAILABLE' } }
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
const userFence = {
  fencedAt: new Date(now - 500).toISOString(),
  reason: 'rollback_cohort',
  actor: { kind: 'user', userId: actorUserId },
}
const fenced: CurrentLeadTurnProduct = {
  ...admitted,
  rollbackFence: userFence,
  dispatchPermitted: false,
}
const url = 'https://adea.invalid/api/internal/pi-durable/lead-product/current'
const post = () => new Request(url, { method: 'POST', body: JSON.stringify(selectors) })
const fenceFields = [
  'allowedPrincipalIds',
  'authorityRevision',
  'canonicalActorPrincipalId',
  'dispatchPermitted',
  'intentId',
  'rollbackFence',
  'schemaVersion',
  'scopeRef',
  'workspaceId',
]

function run(product: unknown) {
  const counts = { verify: 0, lookup: 0 }
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => now,
    verify: async () => {
      counts.verify++
      return true
    },
    withCurrent: async (_w, _i, disclose) => {
      counts.lookup++
      return disclose(product as CurrentLeadTurnProduct)
    },
  })
  return { handler, counts }
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('missing: dispatchPermitted false with no envelope is refused, and no prompt is served', async () => {
  const result = await json(
    await run({ ...admitted, rollbackFence: null, dispatchPermitted: false }).handler(post())
  )
  expect(result).toEqual(unavailableBody)
  expect(JSON.stringify(result)).not.toContain(admitted.prompt)
})

test('missing: an absent envelope or dispatch flag is refused rather than defaulted', async () => {
  const withoutFence = { ...admitted, rollbackFence: undefined }
  const withoutFlag = { ...admitted, dispatchPermitted: undefined }
  const stringFlag = { ...admitted, dispatchPermitted: 'true' }
  for (const product of [withoutFence, withoutFlag, stringFlag]) {
    expect(await json(await run(product).handler(post()))).toEqual(unavailableBody)
  }
})

test('malformed: an invalid fence timestamp is refused, whether unparseable, non-canonical or not a string', async () => {
  for (const fencedAt of [
    'not-a-time',
    '2026-10-10 11:59:00Z',
    '2026-10-10T11:59:00+00:00',
    '2026-10-10T11:59:00.1Z',
    1_791_000_000_000,
    null,
  ]) {
    const product = { ...fenced, rollbackFence: { ...userFence, fencedAt } }
    expect(await json(await run(product).handler(post()))).toEqual(unavailableBody)
  }
})

test('malformed: an unknown reason or actor kind, or a malformed actor id, is refused', async () => {
  const variants = [
    { ...userFence, reason: 'other' },
    { ...userFence, reason: 'ROLLBACK_COHORT' },
    { ...userFence, actor: { kind: 'system', userId: actorUserId } },
    { ...userFence, actor: { kind: 'user', userId: 'not-a-uuid' } },
    { ...userFence, actor: { kind: 'user', userId: actorUserId, extra: true } },
    { ...userFence, actor: { kind: 'operator', operatorId: 'Bad Operator!' } },
    { ...userFence, actor: { kind: 'operator', operatorId: 'x'.repeat(129) } },
    { ...userFence, actor: null },
    { ...userFence, actor: ['user', actorUserId] },
  ]
  for (const rollbackFence of variants) {
    expect(await json(await run({ ...fenced, rollbackFence }).handler(post()))).toEqual(
      unavailableBody
    )
  }
})

test('malformed: an envelope with extra fields, or one that is not a record, is refused', async () => {
  const variants: unknown[] = [
    { ...userFence, note: 'extra' },
    ['rollback_cohort'],
    'fenced',
    { reason: 'rollback_cohort', actor: { kind: 'user', userId: actorUserId } },
  ]
  for (const rollbackFence of variants) {
    expect(await json(await run({ ...fenced, rollbackFence }).handler(post()))).toEqual(
      unavailableBody
    )
  }
})

test('future: a fence timestamp after the verifier clock is refused, and the boundary itself is accepted', async () => {
  const future = {
    ...fenced,
    rollbackFence: { ...userFence, fencedAt: new Date(now + 1).toISOString() },
  }
  expect(await json(await run(future).handler(post()))).toEqual(unavailableBody)
  const boundary = {
    ...fenced,
    rollbackFence: { ...userFence, fencedAt: new Date(now).toISOString() },
  }
  expect((await run(boundary).handler(post())).status).toBe(200)
})

test('contradiction: a fence whose product says dispatch is permitted is refused', async () => {
  expect(await json(await run({ ...fenced, dispatchPermitted: true }).handler(post()))).toEqual(
    unavailableBody
  )
  expect(await json(await run({ ...fenced, dispatchPermitted: 'false' }).handler(post()))).toEqual(
    unavailableBody
  )
})

test('identity: a valid operator fence is emitted as fence facts bound to the requested selectors only', async () => {
  const operatorFence = {
    fencedAt: new Date(now - 500).toISOString(),
    reason: 'operator_intervention',
    actor: { kind: 'operator', operatorId: 'ops.rollback-1' },
  }
  const result = await json(await run({ ...fenced, rollbackFence: operatorFence }).handler(post()))
  expect(result.status).toBe(200)
  expect(Object.keys(result.body).toSorted()).toEqual(fenceFields)
  expect(result.body).toEqual({
    schemaVersion: 'pi-lead-intent-fence/v2',
    intentId,
    workspaceId: cpWorkspaceId,
    dispatchPermitted: false,
    rollbackFence: operatorFence,
    authorityRevision: fenced.channelVersion,
    canonicalActorPrincipalId: `user:${actorUserId}`,
    scopeRef: expect.stringMatching(/^adea-product:sha256:[0-9a-f]{64}$/),
    allowedPrincipalIds: [selectors.principalId],
  })
  expect(JSON.stringify(result.body)).not.toContain(admitted.prompt)
})

test('identity: a fenced product for another workspace is refused even with a valid envelope', async () => {
  const other = { ...fenced, controlPlaneWorkspaceId: `wsp_${'A'.repeat(26)}` }
  expect(await json(await run(other).handler(post()))).toEqual(unavailableBody)
})

test('preserved: an unfenced dispatchable admission keeps the v1 shape', async () => {
  const result = await json(await run(admitted).handler(post()))
  expect(result.status).toBe(200)
  expect(result.body.schemaVersion).toBe('pi-lead-intent/v1')
  expect(result.body.prompt).toBe(admitted.prompt)
})

test('preserved: a fenced admission past its lifetime still returns fence facts only', async () => {
  const expired = Date.parse(admitted.intentCreatedAt) + 300_000
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => expired,
    verify: async () => true,
    withCurrent: async (_w, _i, disclose) => disclose(fenced),
  })
  const result = await json(await handler(post()))
  expect(result.status).toBe(200)
  expect(Object.keys(result.body).toSorted()).toEqual(fenceFields)
})

test('preserved: an unfenced admission past its lifetime is still refused', async () => {
  const expired = Date.parse(admitted.intentCreatedAt) + 300_000
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => expired,
    verify: async () => true,
    withCurrent: async (_w, _i, disclose) => disclose(admitted),
  })
  expect(await json(await handler(post()))).toEqual(unavailableBody)
})
