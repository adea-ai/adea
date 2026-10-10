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

// Negative contract checks on the Adea side. These run the real handler with the clock and the
// product lookup varied, and they need no control-plane checkout.
async function emitAt(
  product: CurrentLeadTurnProduct | undefined,
  clock: number,
  lookup?: 'reject'
) {
  const handler = createLeadProductReaderHandler({
    lifetimeMs: 300_000,
    now: () => clock,
    verify: async () => true,
    withCurrent: async (_w, _i, disclose) => {
      if (lookup === 'reject') throw new Error('Lead turn unavailable')
      return product ? disclose(product) : undefined
    },
  })
  const response = await handler(
    new Request('https://adea.invalid/api/internal/pi-durable/lead-product/current', {
      method: 'POST',
      body: JSON.stringify(selectors),
    })
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('negative: expired unfenced evidence is refused at the expiry boundary and admitted one millisecond before it', async () => {
  const expiresAt = Date.parse(base.intentCreatedAt) + 300_000
  expect(await emitAt(base, expiresAt - 1)).toMatchObject({ status: 200 })
  expect(await emitAt(base, expiresAt)).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
  expect(await emitAt(base, expiresAt + 60_000)).toEqual({
    status: 404,
    body: { code: 'LEAD_PRODUCT_UNAVAILABLE' },
  })
})

test('negative: an archived admission is 404 whether the lookup returns nothing or denies, and never emits a body', async () => {
  const denied = { status: 404, body: { code: 'LEAD_PRODUCT_UNAVAILABLE' } }
  expect(await emitAt(undefined, now)).toEqual(denied)
  expect(await emitAt(undefined, now, 'reject')).toEqual(denied)
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
    createProductionLeadProductAuthority: evidence.createProductionLeadProductAuthority,
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

// CP's real production authority, with only its own profile and model-selection ports stubbed.
const authorityFor = async (
  cp: Awaited<ReturnType<typeof loadControlPlane>>,
  product: { readCurrent(input: unknown): Promise<unknown> },
  nowIso: string
) => {
  const { DatabaseSync } = await import('node:sqlite')
  const selection = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
  return cp.createProductionLeadProductAuthority({
    database: new DatabaseSync(':memory:'),
    product,
    profiles: {
      resolveImmutable: async (input: {
        profileId: string
        profileVersion: string
        profileRevision: number
      }) => ({
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        profileRevision: input.profileRevision,
        profileVersionId: `pfv_${'0123456789ABCDEFGHJKMNPQRS'}`,
        profileContentDigest: `sha256:${'b'.repeat(64)}`,
      }),
    },
    selections: {
      select: async () => selection,
      resolveSelection: async () => selection,
      assertReady: async () => {},
    },
    target: {
      location: 'remote_host',
      harness: 'pi_durable',
      harnessVersion: '1.1.0',
      providerBinding: 'pi_durable_models',
    },
    now: () => nowIso,
  } as never)
}

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

    test('negative: CP refuses expired v1 evidence and admits it before expiry (same bytes, only the clock differs)', async () => {
      const cp = await loadFromCheckout()
      const unfenced = await contract('unfenced')
      const product = { readCurrent: async () => unfenced.body }
      await expect(
        (await authorityFor(cp, product, '2026-10-09T12:00:00.000Z')).readCurrent(consumerInput)
      ).resolves.toBeDefined()
      await expect(
        (await authorityFor(cp, product, '2026-10-09T13:00:00.000Z')).readCurrent(consumerInput)
      ).rejects.toThrow('PI_PRODUCTION_PRODUCT_DENIED')
    })

    test('negative: CP refuses a fenced admission through its authority, so prepare and dispatch cannot resolve', async () => {
      const cp = await loadFromCheckout()
      const fenced = await contract('fenced')
      const product = {
        readCurrent: (input: unknown) =>
          readerFor(cp, fenced.status, fenced.body).readCurrent(input as never),
      }
      await expect(
        (await authorityFor(cp, product, '2026-10-09T12:00:00.000Z')).readCurrent(consumerInput)
      ).rejects.toThrow('PI_PRODUCT_READER_UNAVAILABLE')
    })

    test('negative: an archived admission (404) yields no CP evidence, which the admission parser then refuses', async () => {
      const cp = await loadFromCheckout()
      const product = {
        readCurrent: (input: unknown) =>
          readerFor(cp, 404, { code: 'LEAD_PRODUCT_UNAVAILABLE' }).readCurrent(input as never),
      }
      expect(
        await (
          await authorityFor(cp, product, '2026-10-09T12:00:00.000Z')
        ).readCurrent(consumerInput)
      ).toBeUndefined()
      expect(() => cp.ProductionLeadProductEvidenceSchema.parse(undefined)).toThrow()
    })
  }
)
