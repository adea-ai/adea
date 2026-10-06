import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  inboundCorrelation,
  proxyMarketplaceCatalog,
  proxyMarketplaceInstall,
  proxyMarketplaceInstallPlan,
} from '../src/server/marketplace-proxy'

const environmentKeys = [
  'CONTROL_PLANE_ORIGIN',
  'CONTROL_PLANE_SERVICE_TOKEN',
  'CONTROL_PLANE_SCOPE_WORKSPACE_ID',
  'CONTROL_PLANE_SIGNING_KEY',
  'CONTROL_PLANE_SIGNING_KEY_ID',
  'CONTROL_PLANE_SIGNING_ISSUER',
] as const
const previousEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
)
const previousFetch = globalThis.fetch

// The suite exercises the static-token fallback unless a test opts into
// signing, whatever the developer's shell exports.
for (const key of environmentKeys) delete process.env[key]

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

  test('scopes every marketplace identity to the authenticated workspace', async () => {
    // Control Plane rejects identities outside the envelope workspace (the
    // tenant is the service scope), and installations are tracked under that
    // scope — so the caller's Agent HQ workspace id never crosses the hop.
    process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.example'
    process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
    const scope = 'wsp_01JABCDEF0123456789ABCDEFG'
    process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID = scope
    const requests: Record<string, unknown>[] = []
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({ data: { ok: true } })
    }

    await proxyMarketplaceCatalog({ userId: 'user-1', workspaceId: 'workspace-1' })
    await proxyMarketplaceInstallPlan({
      instanceId: 'instance-1',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
      workspaceIdentity: { userId: 'user-1', workspaceId: 'workspace-1' },
    })
    await proxyMarketplaceInstall({
      canonicalContentDigest: `sha256:${'a'.repeat(64)}`,
      idempotencyKey: 'marketplace-install-2',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
      workspaceIdentity: { userId: 'user-1', workspaceId: 'workspace-1' },
    })

    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect(request.workspaceId).toBe(scope)
    }
    expect(requests[0]?.parameters).toMatchObject({
      workspaceIdentity: { userId: 'user-1', workspaceId: scope },
    })
    for (const request of requests.slice(1)) {
      const payload = request.payload as { workspaceIdentity: Record<string, unknown> }
      expect(payload.workspaceIdentity).toEqual({ userId: 'user-1', workspaceId: scope })
    }
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

async function configureSigning() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.example'
  process.env.CONTROL_PLANE_SIGNING_KEY = JSON.stringify(
    await crypto.subtle.exportKey('jwk', pair.privateKey)
  )
  process.env.CONTROL_PLANE_SIGNING_KEY_ID = 'adea-web-test'
  process.env.CONTROL_PLANE_SIGNING_ISSUER = 'https://adea.example/control-plane'
  // The static fallback stays configured: signing must take precedence.
  process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
  process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID = 'wsp_01JABCDEF0123456789ABCDEFG'
  return pair.publicKey
}

describe('per-workspace Control Plane scopes (ADR 0013)', () => {
  const homeScope = 'wsp_01JABCDEF0123456789ABCDEF0'
  const workScope = 'wsp_01JABCDEF0123456789ABCDEF1'

  type Sent = { body: Record<string, unknown>; claims: Record<string, unknown>; token: string }

  function captureRequests(sent: Sent[]) {
    globalThis.fetch = (async (_input, init) => {
      const token = String(new Headers(init?.headers).get('Authorization')).replace(/^Bearer /u, '')
      const claims = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8') || 'null'
      ) as Record<string, unknown>
      sent.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, claims, token })
      return Response.json({ data: { ok: true } })
    }) as typeof fetch
  }

  const scopes = {
    'workspace-home': homeScope,
    'workspace-work': workScope,
  } as Record<string, string>
  const resolverFor = (workspaceId: string) => ({
    resolveControlPlaneScope: async () =>
      scopes[workspaceId] ? { workspaceId: scopes[workspaceId]! } : null,
  })

  test('two Adea workspaces reach two Control Plane workspaces', async () => {
    const publicKey = await configureSigning()
    const sent: Sent[] = []
    captureRequests(sent)

    for (const workspaceId of ['workspace-home', 'workspace-work']) {
      await proxyMarketplaceCatalog({ userId: 'user-1', workspaceId }, {}, resolverFor(workspaceId))
      await proxyMarketplaceInstallPlan(
        {
          instanceId: 'instance-1',
          pluginId: 'plugin:openai-official:gmail',
          releaseId: `release:${'b'.repeat(64)}`,
          requestedHarness: 'codex',
          workspaceIdentity: { userId: 'user-1', workspaceId },
        },
        {},
        resolverFor(workspaceId)
      )
      await proxyMarketplaceInstall(
        {
          canonicalContentDigest: `sha256:${'a'.repeat(64)}`,
          idempotencyKey: 'marketplace-install-same-key',
          pluginId: 'plugin:openai-official:gmail',
          releaseId: `release:${'b'.repeat(64)}`,
          requestedHarness: 'codex',
          workspaceIdentity: { userId: 'user-1', workspaceId },
        },
        {},
        resolverFor(workspaceId)
      )
    }

    expect(sent).toHaveLength(6)
    const expected = [homeScope, homeScope, homeScope, workScope, workScope, workScope]
    const requiredScopes = ['marketplace:read', 'marketplace:install', 'marketplace:install']
    for (const [index, hop] of sent.entries()) {
      const scope = expected[index]!
      // Envelope, nested identity and credential name the same workspace.
      expect(hop.body.workspaceId).toBe(scope)
      const identity =
        (hop.body.parameters as { workspaceIdentity?: unknown } | undefined)?.workspaceIdentity ??
        (hop.body.payload as { workspaceIdentity?: unknown }).workspaceIdentity
      expect(identity).toEqual({ userId: 'user-1', workspaceId: scope })
      expect(hop.claims.workspaceIds).toEqual([scope])
      expect(hop.claims.projectIds).toEqual([])
      expect(hop.claims.scopes).toEqual([requiredScopes[index % 3]])
      expect(hop.token).not.toBe('test-token')
      const [header, payload, signature] = hop.token.split('.')
      expect(
        await crypto.subtle.verify(
          { name: 'Ed25519' },
          publicKey,
          Buffer.from(signature!, 'base64url'),
          new TextEncoder().encode(`${header}.${payload}`)
        )
      ).toBeTrue()
    }
    // Plan idempotency is namespaced per workspace scope.
    expect(sent[1]?.body.idempotencyKey).not.toBe(sent[4]?.body.idempotencyKey)
    // The Control Plane keys install idempotency by (workspace, key); the same
    // client key therefore lands in two distinct namespaces.
    expect(sent[2]?.body.idempotencyKey).toBe('marketplace-install-same-key')
    expect(sent[2]?.body.workspaceId).not.toBe(sent[5]?.body.workspaceId)
  })

  test('fails closed when the workspace has no mapped scope', async () => {
    await configureSigning()
    const sent: Sent[] = []
    captureRequests(sent)
    const failure = await proxyMarketplaceCatalog(
      { userId: 'user-1', workspaceId: 'workspace-unknown' },
      {},
      resolverFor('workspace-unknown')
    ).catch((error: unknown) => error as { code?: string; status?: number })
    expect(failure).toMatchObject({ code: 'CONTROL_PLANE_UNAVAILABLE', status: 503 })
    expect(sent).toHaveLength(0)
  })

  test('without the signing key, keeps the static token and single scope', async () => {
    process.env.CONTROL_PLANE_ORIGIN = 'https://control-plane.example'
    process.env.CONTROL_PLANE_SERVICE_TOKEN = 'test-token'
    process.env.CONTROL_PLANE_SCOPE_WORKSPACE_ID = 'wsp_01JABCDEF0123456789ABCDEFG'
    const sent: Sent[] = []
    captureRequests(sent)
    let resolved = false
    await proxyMarketplaceCatalog(
      { userId: 'user-1', workspaceId: 'workspace-home' },
      {},
      {
        resolveControlPlaneScope: async () => {
          resolved = true
          return { workspaceId: homeScope }
        },
      }
    )
    expect(resolved).toBeFalse()
    expect(sent[0]?.token).toBe('test-token')
    expect(sent[0]?.body.workspaceId).toBe('wsp_01JABCDEF0123456789ABCDEFG')

    // The plan idempotency key keeps its original derivation (the caller's
    // input, Adea workspace id included), so in-flight retries still replay.
    const input = {
      instanceId: 'instance-1',
      pluginId: 'plugin:openai-official:gmail',
      releaseId: `release:${'b'.repeat(64)}`,
      requestedHarness: 'codex',
      workspaceIdentity: { userId: 'user-1', workspaceId: 'workspace-home' },
    }
    await proxyMarketplaceInstallPlan(input)
    const canonical = `{"instanceId":"instance-1","pluginId":"plugin:openai-official:gmail","releaseId":"release:${'b'.repeat(64)}","requestedHarness":"codex","workspaceIdentity":{"userId":"user-1","workspaceId":"workspace-home"}}`
    expect(sent[1]?.body.idempotencyKey).toBe(
      `marketplace-plan:${createHash('sha256').update(canonical).digest('hex')}`
    )
  })
})
