import { describe, expect, test } from 'bun:test'
import type { CurrentLeadTurnProduct } from '@adea-ai/db'
import { createLeadProductReaderHandler } from '../src/server/lead-product-reader'

// Golden wire contract for the signed current product reader. The fixtures are the exact bodies the
// real handler emits for the inputs below. The drift test runs everywhere. The consumer test runs the
// control-plane's own parser and HTTP reader from a local checkout, and is skipped without one.

const contract = (name: string) =>
  Bun.file(
    new URL(`./contracts/lead-product-current.${name}.json`, import.meta.url)
  ).json() as Promise<{
    status: number
    body: Record<string, unknown>
  }>

const cpWorkspaceId = 'wsp_0123456789ABCDEFGHJKMNPQRS'
const intentId = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7'
const actorUserId = '0f8b7c2e-1a2b-4c3d-8e9f-001122334455'
const now = Date.UTC(2026, 9, 9, 12)
const selectors = { workspaceId: cpWorkspaceId, intentId, principalId: 'svc_control-plane' }
const base: CurrentLeadTurnProduct = {
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
const fencedProduct: CurrentLeadTurnProduct = {
  ...base,
  rollbackFence: {
    fencedAt: new Date(now - 500).toISOString(),
    reason: 'rollback_cohort',
    actor: { kind: 'user', userId: actorUserId },
  },
  dispatchPermitted: false,
}

async function emit(product: CurrentLeadTurnProduct) {
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => now,
    verify: async () => true,
    withCurrent: async (_w, _i, disclose) => disclose(product),
  })
  const response = await handler(
    new Request('https://adea.invalid/api/internal/pi-durable/lead-product/current', {
      method: 'POST',
      body: JSON.stringify(selectors),
    })
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('the emitted unfenced and fence-only bodies match the committed golden contract', async () => {
  expect(await emit(base)).toEqual(await contract('unfenced'))
  expect(await emit(fencedProduct)).toEqual(await contract('fenced'))
})

const controlPlaneCheckout = process.env.CONTROL_PLANE_CHECKOUT

// Loads the control-plane's own modules from the checkout named by CONTROL_PLANE_CHECKOUT.
const loadControlPlane = async (root: string) => {
  const [evidence, http] = await Promise.all([
    import(`${root}/apps/control-api/src/models/production-lead-product.ts`),
    import(`${root}/apps/control-api/src/models/production-product-http.ts`),
  ])
  return {
    ProductionLeadProductEvidenceSchema: evidence.ProductionLeadProductEvidenceSchema,
    createProductionProductHttpReader: http.createProductionProductHttpReader,
  }
}

const loadFromCheckout = () => loadControlPlane(controlPlaneCheckout!)

// The control-plane HTTP reader, fed with the exact status and body Adea's handler emitted.
const readerFor = (
  cp: Awaited<ReturnType<typeof loadControlPlane>>,
  status: number,
  body: unknown
) =>
  cp.createProductionProductHttpReader({
    endpoint: 'https://adea.example/api/internal/pi-durable/lead-product/current',
    credentials: { getExistingCredential: async () => 'aaaa.bbbb.cccc' },
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  })

describe.skipIf(!controlPlaneCheckout)(
  'control-plane consumer reads the committed contract',
  () => {
    const consumerInput = {
      schemaVersion: 'pi-lead-intent/v1' as const,
      intentId,
      workspaceId: cpWorkspaceId,
      principalId: 'svc_control-plane',
    }

    test('the strict evidence parser accepts the unfenced v1 body and refuses the fence-only body', async () => {
      const cp = await loadFromCheckout()
      const unfenced = await contract('unfenced')
      expect(() => cp.ProductionLeadProductEvidenceSchema.parse(unfenced.body)).not.toThrow()
      const fenced = await contract('fenced')
      expect(() => cp.ProductionLeadProductEvidenceSchema.parse(fenced.body)).toThrow()
    })

    test('the control-plane HTTP reader returns v1 evidence and refuses a fenced admission as unavailable', async () => {
      const cp = await loadFromCheckout()
      const unfenced = await contract('unfenced')
      const admitted = await readerFor(cp, unfenced.status, unfenced.body).readCurrent(
        consumerInput
      )
      expect(admitted).toMatchObject({ intentId, schemaVersion: 'pi-lead-intent/v1' })
      const fenced = await contract('fenced')
      await expect(
        readerFor(cp, fenced.status, fenced.body).readCurrent(consumerInput)
      ).rejects.toThrow('PI_PRODUCT_READER_UNAVAILABLE')
    })
  }
)
