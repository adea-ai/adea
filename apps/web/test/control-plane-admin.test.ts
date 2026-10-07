import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  parseCatalogLifecycle,
  parseCloudConnectionCreate,
  parseCloudConnectionRotate,
  parseListQuery,
  parseSkillPublish,
} from '../src/server/control-plane-admin-request'
import {
  handleCatalogLifecycle,
  handleCatalogList,
  handleCloudConnectionCreate,
  handleCloudConnectionRevoke,
  handleCloudConnectionRotate,
  handleCloudConnectionsList,
  handleSkillPublish,
  type AdminRouteDependencies,
} from '../src/server/control-plane-admin-routes'
import { canonicalJson } from '../src/server/control-plane-client'
import { CLOUD_CONNECTION_SECRET_FIELDS } from '../src/server/control-plane-credentials-proxy'
import type { WorkspacePrincipalResolution } from '../src/server/workspace-principal'

const WSP = 'wsp_01JABCDEF0123456789ABCDEFG'
const SKILL = 'skl_01JABCDEF0123456789ABCDEFG'
const SKILL_VERSION = 'skv_01JABCDEF0123456789ABCDEFG'
const PROFILE = 'prf_01JABCDEF0123456789ABCDEFG'
const CREDENTIAL = 'crd_01JABCDEF0123456789ABCDEFG'
const ORIGIN = 'https://control-plane.example'
const KEY = 'idempotency-key-0001'
/** Inert canary standing in for a real secret; it must never come back out. */
const CANARY = 'canary-secret-7f3d9a1c-do-not-echo'

type Recorded = Readonly<{ url: string; authorization: string; body: Record<string, unknown> }>

let signingKeyPem: string | undefined
async function signingKey(): Promise<string> {
  if (signingKeyPem) return signingKeyPem
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  signingKeyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64')}\n-----END PRIVATE KEY-----\n`
  return signingKeyPem
}

async function scopedEnvironment(): Promise<Record<string, string>> {
  return {
    CONTROL_PLANE_ORIGIN: ORIGIN,
    CONTROL_PLANE_SIGNING_ISSUER: 'https://adea.example/control-plane',
    CONTROL_PLANE_SIGNING_KEY: await signingKey(),
    CONTROL_PLANE_SIGNING_KEY_ID: 'adea-web-test-signer',
  }
}

/** No signing key; a leftover static token from the retired fallback is ignored. */
const unsignedEnvironment = {
  CONTROL_PLANE_ORIGIN: ORIGIN,
  CONTROL_PLANE_SCOPE_WORKSPACE_ID: WSP,
  CONTROL_PLANE_SERVICE_TOKEN: 'static-fallback-token',
}

function claims(authorization: string): Record<string, unknown> {
  const payload = authorization.replace(/^Bearer /u, '').split('.')[1]!
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

const skillRecord = {
  createdAt: '2026-10-06T12:00:00.000Z',
  displayName: 'Release notes',
  ownership: { scope: 'workspace', workspaceId: WSP },
  readOnly: false,
  skillId: SKILL,
}
const skillVersion = {
  contentDigest: `sha256:${'c'.repeat(64)}`,
  createdAt: '2026-10-06T12:00:00.000Z',
  lifecycle: 'published',
  lifecycleMetadata: { publishedAt: '2026-10-06T12:00:00.000Z' },
  revision: 2,
  semanticVersion: '1.0.0',
  skillId: SKILL,
  skillVersionId: SKILL_VERSION,
}
const credentialRecord = {
  connectorRef: 'connector:github',
  createdAt: '2026-10-06T12:00:00.000Z',
  createdBy: 'svc_agent-hq',
  credentialId: CREDENTIAL,
  provider: 'github',
  revision: 1,
  status: 'active',
  workspaceId: WSP,
}

/** A Control Plane double answering by path with the real response identity. */
function controlPlane(
  answer: (path: string, body: Record<string, unknown>) => Response = defaultAnswer
) {
  const requests: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      body,
      url: url.pathname,
    })
    const response = answer(url.pathname, body)
    const payload = (await response.json()) as Record<string, unknown>
    return Response.json(
      {
        contractVersion: body.contractVersion,
        requestId: body.requestId,
        correlation: body.correlation,
        ...payload,
      },
      { status: response.status }
    )
  }) as typeof fetch
  return { fetchImpl, requests }
}

function envelope(data: unknown): Response {
  return Response.json({ data })
}

function defaultAnswer(path: string): Response {
  if (path === '/v1/catalog/skills/list')
    return envelope({
      items: [
        { latestVersion: skillVersion, skill: skillRecord },
        {
          skill: {
            ...skillRecord,
            displayName: 'System review',
            ownership: { scope: 'system' },
            // A system item stays read-only even if a record claims otherwise.
            readOnly: false,
            skillId: 'skl_01JABCDEF0123456789ABCDEFH',
          },
        },
      ],
      page: { nextCursor: 'cur_abcdefgh' },
    })
  if (path === '/v1/catalog/profiles/list') return envelope({ items: [], page: {} })
  if (path === '/v1/catalog/skills/publish')
    return envelope({ skill: skillRecord, version: { ...skillVersion, content: {}, manifest: {} } })
  if (path.startsWith('/v1/catalog/'))
    return envelope({
      changed: [{ ...skillVersion, lifecycle: 'deprecated', revision: 3 }],
      skill: skillRecord,
    })
  if (path === '/v1/credentials/list')
    return envelope({ credentials: [credentialRecord], nextCursor: 'cur_abcdefgh' })
  return envelope({ credential: credentialRecord })
}

const member: WorkspacePrincipalResolution = {
  clearTemporaryCredential: false,
  principal: { kind: 'user', userId: 'user-member' },
  sessionRotated: false,
  temporary: false,
}

type Role = 'admin' | 'member' | 'none'

function failure(_request: Request, code: string, message: string, status: number): Response {
  return Response.json({ code, message }, { status })
}

function dependencies(
  role: Role,
  hop: Readonly<{ environment: Record<string, string>; fetchImpl: typeof fetch }>,
  resolution: WorkspacePrincipalResolution | null = member
): AdminRouteDependencies & { authorizations: string[] } {
  const authorizations: string[] = []
  return {
    authorizations,
    authorize: async (_principal, permission, workspaceId) => {
      authorizations.push(`${permission}:${workspaceId}`)
      if (role === 'none') return false
      return permission === 'workspace.read' || role === 'admin'
    },
    canManage: async () => role === 'admin',
    failure,
    guard: () => null,
    hop: (workspaceId) => ({
      environment: hop.environment,
      fetch: hop.fetchImpl,
      resolveControlPlaneScope: async () =>
        workspaceId === 'adea-ws-1' ? { workspaceId: WSP } : null,
    }),
    invalid: () => failure(new Request(ORIGIN), 'invalid_request', 'Invalid request', 400),
    json: (payload, _resolution, _request, init) => Response.json(payload, init),
    resolvePrincipal: async () => resolution,
    unavailable: (_request, status = 404) =>
      Response.json({ code: 'workspace_unavailable' }, { status }),
  }
}

function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`https://adea.example${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
}

const consoleSpies: ReturnType<typeof spyOn>[] = []
function captureConsole(): () => string {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const spy = spyOn(console, method).mockImplementation(() => undefined)
    consoleSpies.push(spy)
  }
  return () => JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls))
}

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore()
})

describe('workspace skills proxy', () => {
  test('lists under a signed credential with only catalog:read for the mapped workspace', async () => {
    const upstream = controlPlane()
    const deps = dependencies('member', {
      environment: await scopedEnvironment(),
      fetchImpl: upstream.fetchImpl,
    })
    const response = await handleCatalogList(
      'skill',
      request('/api/workspaces/adea-ws-1/skills'),
      'adea-ws-1',
      deps
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload).toEqual({
      canManage: false,
      items: [
        {
          createdAt: '2026-10-06T12:00:00.000Z',
          displayName: 'Release notes',
          id: SKILL,
          kind: 'skill',
          latestVersion: {
            contentDigest: `sha256:${'c'.repeat(64)}`,
            createdAt: '2026-10-06T12:00:00.000Z',
            lifecycle: 'published',
            revision: 2,
            version: '1.0.0',
            versionId: SKILL_VERSION,
          },
          owner: 'workspace',
          readOnly: false,
        },
        {
          createdAt: '2026-10-06T12:00:00.000Z',
          displayName: 'System review',
          id: 'skl_01JABCDEF0123456789ABCDEFH',
          kind: 'skill',
          owner: 'system',
          readOnly: true,
        },
      ],
      nextCursor: 'cur_abcdefgh',
    })
    const [hop] = upstream.requests
    expect(hop?.url).toBe('/v1/catalog/skills/list')
    expect(claims(hop!.authorization)).toMatchObject({
      projectIds: [],
      scopes: ['catalog:read'],
      workspaceIds: [WSP],
    })
    expect(hop?.body).toMatchObject({
      caller: { servicePrincipalId: 'svc_agent-hq' },
      contractVersion: { major: 3, minor: 0 },
      operation: 'catalog.skill.list',
      parameters: { limit: 100 },
      workspaceId: WSP,
    })
    expect(hop?.body.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(hop?.body.correlation).toEqual({
      traceId: expect.stringMatching(/^trc_[0-9A-HJKMNP-TV-Z]{26}$/u),
    })
  })

  test('publish asks for catalog:publish and lifecycle changes for catalog:manage', async () => {
    const upstream = controlPlane()
    const deps = dependencies('admin', {
      environment: await scopedEnvironment(),
      fetchImpl: upstream.fetchImpl,
    })
    const published = await handleSkillPublish(
      request('/api/workspaces/adea-ws-1/skills', {
        content: { artifactRefs: [], instructions: 'Summarize merged changes.' },
        displayName: 'Release notes',
        idempotencyKey: KEY,
        manifest: { semanticVersion: '1.0.0' },
      }),
      'adea-ws-1',
      deps
    )
    expect(published.status).toBe(201)
    expect(await published.json()).toMatchObject({
      item: { id: SKILL, owner: 'workspace' },
      version: { version: '1.0.0', versionId: SKILL_VERSION },
    })
    const revoked = await handleCatalogLifecycle(
      'profile',
      'revoke',
      request(`/api/workspaces/adea-ws-1/skills/profiles/${PROFILE}/revoke`, {
        idempotencyKey: KEY,
        reason: 'Retired',
      }),
      'adea-ws-1',
      PROFILE,
      dependencies('admin', {
        environment: await scopedEnvironment(),
        fetchImpl: controlPlane(() =>
          Response.json({
            data: {
              changed: [],
              profile: { ...skillRecord, profileId: PROFILE, skillId: undefined },
            },
          })
        ).fetchImpl,
      })
    )
    expect(revoked.status).toBe(200)
    const deprecated = await handleCatalogLifecycle(
      'skill',
      'deprecate',
      request(`/api/workspaces/adea-ws-1/skills/${SKILL}/deprecate`, {
        expectedRevision: 2,
        idempotencyKey: KEY,
        reason: 'Replaced by 2.0.0',
        versionId: SKILL_VERSION,
      }),
      'adea-ws-1',
      SKILL,
      deps
    )
    expect(deprecated.status).toBe(200)
    expect(((await deprecated.json()) as { changed: unknown[] }).changed).toHaveLength(1)

    const [publish, deprecate] = upstream.requests
    expect(claims(publish!.authorization).scopes).toEqual(['catalog:publish'])
    expect(publish?.body).toMatchObject({
      idempotencyKey: `catalog-skill-publish:${KEY}`,
      operation: 'catalog.skill.publish',
      payload: { displayName: 'Release notes', manifest: { semanticVersion: '1.0.0' } },
    })
    const payload = publish?.body.payload as Record<string, string>
    expect(payload.skillId).toMatch(/^skl_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(payload.skillVersionId).toMatch(/^skv_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(publish?.body.commandId).toMatch(/^cmd_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(claims(deprecate!.authorization).scopes).toEqual(['catalog:manage'])
    expect(deprecate?.body).toMatchObject({
      operation: 'catalog.skill.deprecate',
      payload: {
        expectedRevision: 2,
        reason: 'Replaced by 2.0.0',
        skillId: SKILL,
        skillVersionId: SKILL_VERSION,
      },
    })
  })

  test('a Control Plane rejection keeps its code but never its message', async () => {
    const readCalls = captureConsole()
    const upstream = controlPlane(() =>
      Response.json(
        {
          error: {
            class: 'authorization',
            code: 'CATALOG_ITEM_READ_ONLY',
            message: 'upstream detail <script>',
            retryable: false,
            source: 'policy',
          },
        },
        { status: 403 }
      )
    )
    const response = await handleCatalogLifecycle(
      'skill',
      'revoke',
      request(`/api/workspaces/adea-ws-1/skills/${SKILL}/revoke`, {
        idempotencyKey: KEY,
        reason: 'x',
      }),
      'adea-ws-1',
      SKILL,
      dependencies('admin', {
        environment: await scopedEnvironment(),
        fetchImpl: upstream.fetchImpl,
      })
    )
    expect(response.status).toBe(403)
    const body = (await response.json()) as { code: string; message: string }
    expect(body.code).toBe('CATALOG_ITEM_READ_ONLY')
    expect(body.message).not.toContain('upstream detail')
    expect(readCalls()).toContain('control_plane.admin.failed')
  })
})

describe('cloud connections proxy', () => {
  test('creates with credential:write, hashes without the secret, and never echoes it', async () => {
    const readCalls = captureConsole()
    const upstream = controlPlane()
    const response = await handleCloudConnectionCreate(
      request('/api/workspaces/adea-ws-1/cloud-connections', {
        connectorRef: 'connector:github',
        idempotencyKey: KEY,
        provider: 'github',
        secret: CANARY,
      }),
      'adea-ws-1',
      dependencies('admin', {
        environment: await scopedEnvironment(),
        fetchImpl: upstream.fetchImpl,
      })
    )
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain(CANARY.slice(0, 12))
    expect(JSON.parse(text)).toEqual({
      connection: {
        connectorRef: 'connector:github',
        createdAt: '2026-10-06T12:00:00.000Z',
        credentialId: CREDENTIAL,
        provider: 'github',
        revision: 1,
        status: 'active',
      },
    })
    expect(response.headers.get('cache-control')).toBe('private, no-store')

    const [hop] = upstream.requests
    expect(hop?.url).toBe('/v1/credentials/create')
    expect(claims(hop!.authorization)).toMatchObject({
      scopes: ['credential:write'],
      workspaceIds: [WSP],
    })
    // The secret is forwarded exactly once, in the payload, and nowhere else.
    expect(JSON.stringify(hop?.body).split(CANARY)).toHaveLength(2)
    expect(hop?.body.payload).toEqual({
      connectorRef: 'connector:github',
      provider: 'github',
      secret: CANARY,
    })
    expect(hop?.body.payloadHash).toBe(
      createHash('sha256')
        .update(canonicalJson({ connectorRef: 'connector:github', provider: 'github' }))
        .digest('hex')
    )
    expect(readCalls()).not.toContain(CANARY)
  })

  test('rotation, revocation and listing never return secret material', async () => {
    const readCalls = captureConsole()
    const upstream = controlPlane()
    const deps = dependencies('admin', {
      environment: await scopedEnvironment(),
      fetchImpl: upstream.fetchImpl,
    })
    const rotated = await handleCloudConnectionRotate(
      request(`/api/workspaces/adea-ws-1/cloud-connections/${CREDENTIAL}/rotate`, {
        expectedRevision: 1,
        idempotencyKey: KEY,
        secret: CANARY,
      }),
      'adea-ws-1',
      CREDENTIAL,
      deps
    )
    const revoked = await handleCloudConnectionRevoke(
      request(`/api/workspaces/adea-ws-1/cloud-connections/${CREDENTIAL}/revoke`, {
        idempotencyKey: KEY,
      }),
      'adea-ws-1',
      CREDENTIAL,
      deps
    )
    const listed = await handleCloudConnectionsList(
      request('/api/workspaces/adea-ws-1/cloud-connections'),
      'adea-ws-1',
      deps
    )
    for (const response of [rotated, revoked, listed]) {
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain(CANARY.slice(0, 12))
    }
    const [rotate, revoke, list] = upstream.requests
    expect(rotate?.body.payload).toEqual({
      credentialId: CREDENTIAL,
      expectedRevision: 1,
      secret: CANARY,
    })
    expect(rotate?.body.payloadHash).toBe(
      createHash('sha256')
        .update(canonicalJson({ credentialId: CREDENTIAL, expectedRevision: 1 }))
        .digest('hex')
    )
    expect(revoke?.body.payload).toEqual({ credentialId: CREDENTIAL })
    expect(claims(revoke!.authorization).scopes).toEqual(['credential:write'])
    expect(claims(list!.authorization).scopes).toEqual(['credential:read'])
    expect(list?.body.operation).toBe('credential.list')
    expect(readCalls()).not.toContain(CANARY)
  })

  test('a failed create logs no secret and returns no upstream text', async () => {
    const readCalls = captureConsole()
    const upstream = controlPlane(() =>
      Response.json(
        {
          error: {
            class: 'conflict',
            code: 'CREDENTIAL_EXISTS',
            message: `duplicate ${CANARY}`,
            retryable: false,
            source: 'persistence',
          },
          echo: CANARY,
        },
        { status: 409 }
      )
    )
    const response = await handleCloudConnectionCreate(
      request('/api/workspaces/adea-ws-1/cloud-connections', {
        connectorRef: 'connector:github',
        idempotencyKey: KEY,
        provider: 'github',
        secret: CANARY,
      }),
      'adea-ws-1',
      dependencies('admin', {
        environment: await scopedEnvironment(),
        fetchImpl: upstream.fetchImpl,
      })
    )
    expect(response.status).toBe(409)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ code: 'CREDENTIAL_EXISTS' })
    expect(text).not.toContain(CANARY)
    const logged = readCalls()
    expect(logged).toContain('control_plane.admin.failed')
    expect(logged).not.toContain(CANARY)
  })

  test('names the secret field for redaction', () => {
    expect(CLOUD_CONNECTION_SECRET_FIELDS).toEqual(['secret'])
  })
})

describe('fail closed', () => {
  test('foreign-workspace records and secret-bearing replies cannot cross the product boundary', async () => {
    const environment = await scopedEnvironment()
    const cases = [
      {
        kind: 'skill',
        data: {
          items: [
            {
              skill: {
                ...skillRecord,
                ownership: { scope: 'workspace', workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
              },
            },
          ],
          page: {},
        },
      },
      {
        kind: 'credential',
        data: {
          credentials: [{ ...credentialRecord, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' }],
        },
      },
      { kind: 'credential', data: { credentials: [{ ...credentialRecord, secret: CANARY }] } },
    ]
    for (const entry of cases) {
      const readCalls = captureConsole()
      const upstream = controlPlane(() => envelope(entry.data))
      const deps = dependencies('member', { environment, fetchImpl: upstream.fetchImpl })
      const response =
        entry.kind === 'skill'
          ? await handleCatalogList('skill', request('/skills'), 'adea-ws-1', deps)
          : await handleCloudConnectionsList(request('/cloud-connections'), 'adea-ws-1', deps)
      expect(response.status).toBe(503)
      const body = await response.text()
      expect(body).not.toContain(CANARY)
      expect(body).not.toContain('Release notes')
      expect(readCalls()).not.toContain(CANARY)
    }
  })

  test('without a signing key every route is unavailable without calling upstream', async () => {
    const upstream = controlPlane()
    const deps = dependencies('admin', {
      environment: unsignedEnvironment,
      fetchImpl: upstream.fetchImpl,
    })
    const responses = await Promise.all([
      handleCatalogList('skill', request('/api/workspaces/adea-ws-1/skills'), 'adea-ws-1', deps),
      handleCatalogList(
        'profile',
        request('/api/workspaces/adea-ws-1/skills/profiles'),
        'adea-ws-1',
        deps
      ),
      handleCloudConnectionsList(
        request('/api/workspaces/adea-ws-1/cloud-connections'),
        'adea-ws-1',
        deps
      ),
      handleCloudConnectionCreate(
        request('/api/workspaces/adea-ws-1/cloud-connections', {
          connectorRef: 'connector:github',
          idempotencyKey: KEY,
          provider: 'github',
          secret: CANARY,
        }),
        'adea-ws-1',
        deps
      ),
      handleSkillPublish(
        request('/api/workspaces/adea-ws-1/skills', {
          content: { instructions: 'x' },
          displayName: 'x',
          idempotencyKey: KEY,
          manifest: { semanticVersion: '1.0.0' },
        }),
        'adea-ws-1',
        deps
      ),
    ])
    for (const response of responses) {
      expect(response.status).toBe(503)
      const body = (await response.json()) as { code: string; message: string }
      expect(body.code).toBe('CONTROL_PLANE_UNAVAILABLE')
      expect(JSON.stringify(body)).not.toContain(CANARY)
    }
    expect(upstream.requests).toEqual([])
  })

  test('an unconfigured or unmapped deployment fails closed as unavailable', async () => {
    const upstream = controlPlane()
    const unconfigured = await handleCloudConnectionsList(
      request('/api/workspaces/adea-ws-1/cloud-connections'),
      'adea-ws-1',
      dependencies('member', {
        environment: { CONTROL_PLANE_ORIGIN: ORIGIN },
        fetchImpl: upstream.fetchImpl,
      })
    )
    expect(unconfigured.status).toBe(503)
    expect(await unconfigured.json()).toMatchObject({ code: 'CONTROL_PLANE_UNAVAILABLE' })
    // A workspace without a mapped `wsp_` never borrows another scope.
    const unmapped = await handleCatalogList(
      'skill',
      request('/api/workspaces/adea-ws-2/skills'),
      'adea-ws-2',
      dependencies('member', {
        environment: await scopedEnvironment(),
        fetchImpl: upstream.fetchImpl,
      })
    )
    expect(unmapped.status).toBe(503)
    expect(upstream.requests).toEqual([])
  })
})

function writes(deps: AdminRouteDependencies): Promise<Response>[] {
  return [
    handleSkillPublish(
      request('/api/workspaces/adea-ws-1/skills', {
        content: { instructions: 'x' },
        displayName: 'x',
        idempotencyKey: KEY,
        manifest: { semanticVersion: '1.0.0' },
      }),
      'adea-ws-1',
      deps
    ),
    handleCatalogLifecycle(
      'skill',
      'deprecate',
      request(`/api/workspaces/adea-ws-1/skills/${SKILL}/deprecate`, {
        idempotencyKey: KEY,
        reason: 'x',
      }),
      'adea-ws-1',
      SKILL,
      deps
    ),
    handleCatalogLifecycle(
      'profile',
      'revoke',
      request(`/api/workspaces/adea-ws-1/skills/profiles/${PROFILE}/revoke`, {
        idempotencyKey: KEY,
        reason: 'x',
      }),
      'adea-ws-1',
      PROFILE,
      deps
    ),
    handleCloudConnectionCreate(
      request('/api/workspaces/adea-ws-1/cloud-connections', {
        connectorRef: 'connector:github',
        idempotencyKey: KEY,
        provider: 'github',
        secret: CANARY,
      }),
      'adea-ws-1',
      deps
    ),
    handleCloudConnectionRotate(
      request(`/api/workspaces/adea-ws-1/cloud-connections/${CREDENTIAL}/rotate`, {
        expectedRevision: 1,
        idempotencyKey: KEY,
        secret: CANARY,
      }),
      'adea-ws-1',
      CREDENTIAL,
      deps
    ),
    handleCloudConnectionRevoke(
      request(`/api/workspaces/adea-ws-1/cloud-connections/${CREDENTIAL}/revoke`, {
        idempotencyKey: KEY,
      }),
      'adea-ws-1',
      CREDENTIAL,
      deps
    ),
  ]
}

describe('route authorization', () => {
  test('a non-member gets the uniform 404 for reads and writes', async () => {
    const upstream = controlPlane()
    const deps = dependencies('none', {
      environment: await scopedEnvironment(),
      fetchImpl: upstream.fetchImpl,
    })
    const responses = await Promise.all([
      handleCatalogList('skill', request('/api/workspaces/adea-ws-1/skills'), 'adea-ws-1', deps),
      handleCloudConnectionsList(
        request('/api/workspaces/adea-ws-1/cloud-connections'),
        'adea-ws-1',
        deps
      ),
      ...writes(deps),
    ])
    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404, 404, 404, 404,
    ])
    expect(upstream.requests).toEqual([])
  })

  test('a member reads but every write is 403 before any upstream call', async () => {
    const upstream = controlPlane()
    const deps = dependencies('member', {
      environment: await scopedEnvironment(),
      fetchImpl: upstream.fetchImpl,
    })
    const responses = await Promise.all(writes(deps))
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403])
    for (const response of responses) expect(await response.text()).not.toContain(CANARY)
    expect(upstream.requests).toEqual([])
    expect(
      deps.authorizations.filter((entry) => entry.startsWith('workspace.update'))
    ).toHaveLength(6)

    const listed = await handleCloudConnectionsList(
      request('/api/workspaces/adea-ws-1/cloud-connections'),
      'adea-ws-1',
      deps
    )
    expect(listed.status).toBe(200)
    expect(((await listed.json()) as { canManage: boolean }).canManage).toBe(false)
  })

  test('an anonymous request is 401 and a desktop-guard rejection short-circuits', async () => {
    const upstream = controlPlane()
    const anonymous = dependencies(
      'admin',
      { environment: await scopedEnvironment(), fetchImpl: upstream.fetchImpl },
      null
    )
    const response = await handleCatalogList(
      'skill',
      request('/api/workspaces/adea-ws-1/skills'),
      'adea-ws-1',
      anonymous
    )
    expect(response.status).toBe(401)
    const guarded = await handleCloudConnectionsList(
      request('/api/workspaces/adea-ws-1/cloud-connections'),
      'adea-ws-1',
      { ...anonymous, guard: () => new Response(null, { status: 403 }) }
    )
    expect(guarded.status).toBe(403)
    expect(upstream.requests).toEqual([])
  })

  test('malformed identifiers and bodies are 400 before any upstream call', async () => {
    const upstream = controlPlane()
    const deps = dependencies('admin', {
      environment: await scopedEnvironment(),
      fetchImpl: upstream.fetchImpl,
    })
    const responses = await Promise.all([
      handleCatalogLifecycle(
        'skill',
        'revoke',
        request('/api/workspaces/adea-ws-1/skills/not-a-skill/revoke', {
          idempotencyKey: KEY,
          reason: 'x',
        }),
        'adea-ws-1',
        'not-a-skill',
        deps
      ),
      handleCloudConnectionRotate(
        request('/api/workspaces/adea-ws-1/cloud-connections/crd_bad/rotate', {
          expectedRevision: 1,
          idempotencyKey: KEY,
          secret: CANARY,
        }),
        'adea-ws-1',
        'crd_bad',
        deps
      ),
      handleCloudConnectionCreate(
        request('/api/workspaces/adea-ws-1/cloud-connections', {
          connectorRef: 'connector:github',
          idempotencyKey: KEY,
          provider: 'github',
          secret: `${CANARY}\n`,
        }),
        'adea-ws-1',
        deps
      ),
      handleCatalogList(
        'skill',
        request('/api/workspaces/adea-ws-1/skills?cursor=nope'),
        'adea-ws-1',
        deps
      ),
    ])
    for (const response of responses) {
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain(CANARY)
    }
    expect(upstream.requests).toEqual([])
  })
})

describe('strict request decoding', () => {
  test('cloud connection create accepts exactly the contract fields', () => {
    const now = Date.UTC(2026, 9, 6)
    const valid = {
      connectorRef: 'connector:github',
      idempotencyKey: KEY,
      provider: 'github',
      secret: CANARY,
    }
    expect(parseCloudConnectionCreate(valid, now)).toEqual(valid)
    expect(
      parseCloudConnectionCreate({ ...valid, expiresAt: '2027-01-01T00:00:00+00:00' }, now)
    ).toEqual({ ...valid, expiresAt: '2027-01-01T00:00:00.000Z' })
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, secret: 'short' },
      { ...valid, secret: 'has\u0007bell-char' },
      { ...valid, provider: 'GitHub' },
      { ...valid, connectorRef: '-leading' },
      { ...valid, idempotencyKey: 'short' },
      { ...valid, expiresAt: '2020-01-01T00:00:00.000Z' },
      { ...valid, expiresAt: 'tomorrow' },
      [valid],
      null,
    ])
      expect(parseCloudConnectionCreate(invalid, now)).toBeNull()
    // Whitespace can be part of a secret; it is never trimmed.
    expect(parseCloudConnectionCreate({ ...valid, secret: ` ${CANARY} ` }, now)?.secret).toBe(
      ` ${CANARY} `
    )
  })

  test('rotate, lifecycle, publish and list queries reject anything extra', () => {
    expect(
      parseCloudConnectionRotate({ expectedRevision: 0, idempotencyKey: KEY, secret: CANARY })
    ).toBeNull()
    expect(
      parseCloudConnectionRotate({ expectedRevision: 2, idempotencyKey: KEY, secret: CANARY })
    ).toEqual({ expectedRevision: 2, idempotencyKey: KEY, secret: CANARY })
    expect(parseCatalogLifecycle('skill', { idempotencyKey: KEY, reason: '  ' })).toBeNull()
    expect(
      parseCatalogLifecycle('skill', { idempotencyKey: KEY, reason: 'x', versionId: SKILL_VERSION })
    ).toBeNull()
    expect(
      parseCatalogLifecycle('profile', {
        expectedRevision: 1,
        idempotencyKey: KEY,
        reason: 'x',
        versionId: SKILL_VERSION,
      })
    ).toBeNull()
    expect(
      parseSkillPublish({
        content: { instructions: 'x' },
        displayName: 'x',
        idempotencyKey: KEY,
        manifest: [],
      })
    ).toBeNull()
    expect(
      parseSkillPublish({
        content: { instructions: 'x'.repeat(300 * 1024) },
        displayName: 'x',
        idempotencyKey: KEY,
        manifest: {},
      })
    ).toBeNull()
    expect(parseListQuery(new Request('https://a.example/x?cursor=cur_abcdefgh'))).toEqual({
      cursor: 'cur_abcdefgh',
    })
    expect(parseListQuery(new Request('https://a.example/x?limit=5'))).toBeNull()
  })
})
