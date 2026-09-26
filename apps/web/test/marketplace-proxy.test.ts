import { afterEach, describe, expect, test } from 'bun:test'

import {
  inboundCorrelation,
  proxyMarketplaceCatalog,
  proxyMarketplaceInstall,
} from '../src/server/marketplace-proxy'

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

  test('carries an inbound request/trace id across the Control Plane hop', async () => {
    // One incident has to correlate across every hop. When the caller already
    // has ids, the hop reuses them instead of starting a new chain at the
    // proxy boundary — and a malformed or unbounded value is discarded
    // rather than forwarded, so a propagated id is never trusted, only carried.
    process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.example'
    process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
    process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID = 'wsp_01JABCDEF0123456789ABCDEFG'
    const sent: Array<{ body: Record<string, unknown>; headers: HeadersInit | undefined }> = []
    globalThis.fetch = async (_input, init) => {
      sent.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: init?.headers,
      })
      return Response.json({ data: { ok: true } })
    }

    const inbound = inboundCorrelation(
      new Request('https://app.example/api/marketplace/catalog', {
        headers: { 'x-request-id': 'edge-req-42', 'x-correlation-id': 'edge-trace-7' },
      })
    )
    await proxyMarketplaceCatalog({ userId: 'user-1', workspaceId: 'workspace-1' }, inbound)

    expect(sent[0]?.body.requestId).toBe('edge-req-42')
    expect(sent[0]?.body.correlation).toMatchObject({ traceId: 'edge-trace-7' })
    const headers = new Headers(sent[0]?.headers)
    expect(headers.get('x-request-id')).toBe('edge-req-42')

    // Absent, malformed, or unbounded inbound ids never reach the Control Plane.
    for (const bad of [
      {},
      { 'x-request-id': 'has spaces' },
      { 'x-request-id': 'x'.repeat(200) },
      { 'x-request-id': 'a'.repeat(200) },
    ]) {
      const request = new Request('https://app.example/api/marketplace/catalog', { headers: bad })
      await proxyMarketplaceCatalog(
        { userId: 'user-1', workspaceId: 'workspace-1' },
        inboundCorrelation(request)
      )
    }
    for (const hop of sent.slice(1))
      expect(hop.body.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/u)
  })

  test('returns the request id on the streaming catalog response', async () => {
    process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.example'
    process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
    process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID = 'wsp_01JABCDEF0123456789ABCDEFG'
    globalThis.fetch = async () =>
      new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } })

    const response = await proxyMarketplaceCatalog(
      { userId: 'user-1', workspaceId: 'workspace-1' },
      { requestId: 'edge-req-99' }
    )
    expect(response.headers.get('x-request-id')).toBe('edge-req-99')
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
