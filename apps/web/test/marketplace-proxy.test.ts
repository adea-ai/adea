import { afterEach, describe, expect, test } from 'bun:test'

import { proxyMarketplaceCatalog, proxyMarketplaceInstall } from '../src/server/marketplace-proxy'

const environmentKeys = [
  'CONTROL_PLANE_ORIGIN',
  'CONTROL_PLANE_SERVICE_TOKEN',
  'CONTROL_PLANE_SCOPE_WORKSPACE_ID',
] as const
const previousEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
)
const previousFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = previousFetch
  for (const key of environmentKeys) {
    const value = previousEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('marketplace Control Plane proxy', () => {
  test('emits canonical opaque identifiers in service envelopes', async () => {
    process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.example'
    process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
    process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID = 'wsp_01JABCDEF0123456789ABCDEFG'
    const requests: Record<string, unknown>[] = []
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({ data: { ok: true } })
    }

    await proxyMarketplaceCatalog({ userId: 'user-1', workspaceId: 'workspace-1' })
    await proxyMarketplaceInstall({
      canonicalContentDigest: `sha256:${'a'.repeat(64)}`,
      idempotencyKey: 'marketplace-install-1',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
      workspaceIdentity: { userId: 'user-1', workspaceId: 'workspace-1' },
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(requests[0]?.correlation).toMatchObject({
      traceId: expect.stringMatching(/^trc_[0-9A-HJKMNP-TV-Z]{26}$/u),
    })
    expect(requests[1]?.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(requests[1]?.commandId).toMatch(/^cmd_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(requests[1]?.correlation).toMatchObject({
      traceId: expect.stringMatching(/^trc_[0-9A-HJKMNP-TV-Z]{26}$/u),
    })
  })

  test('streams large catalog responses through without parsing', async () => {
    // Buffering + re-serializing the multi-megabyte catalog in the worker
    // exceeds Cloudflare's resource limits, so the catalog read must pass
    // the Control Plane response through verbatim.
    process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.example'
    process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
    process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID = 'wsp_01JABCDEF0123456789ABCDEFG'
    const envelope = JSON.stringify({
      data: { catalogId: 'catalog-1', artifacts: { 'catalog.v1.json': '{}'.repeat(64) } },
      meta: {},
    })
    let sawCredential = false
    globalThis.fetch = (async (_input, init) => {
      sawCredential =
        String(new Headers(init?.headers).get('Authorization')) === 'Bearer test-token'
      return new Response(envelope, { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const response = await proxyMarketplaceCatalog({ userId: 'user-1', workspaceId: 'workspace-1' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    // Verbatim passthrough: the envelope reaches the caller unparsed.
    expect(await response.text()).toBe(envelope)
    expect(sawCredential).toBeTrue()
  })

  test('preserves the upstream status when the Control Plane rejects a read', async () => {
    process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.example'
    process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
    process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID = 'wsp_01JABCDEF0123456789ABCDEFG'
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'NOPE' } }), { status: 404 })) as typeof fetch

    const failure = await proxyMarketplaceCatalog({
      userId: 'user-1',
      workspaceId: 'workspace-1',
    }).catch((error: unknown) => error as { status?: number })

    expect(failure?.status).toBe(404)
  })
})
