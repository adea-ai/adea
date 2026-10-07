import { describe, expect, test } from 'bun:test'
import { resolveAgentProfilePin } from '../src/server/agent-profile-pin'
import { handleAgentProfileChange } from '../src/server/agent-profile-route'
import type { ApiAgentProfileInput } from '@adea-ai/api-client'
import type { AgentSummary } from '@adea-ai/types'

const suffix = '01JABCDEF0123456789ABCDEFG'
const profileId = `prf_${suffix}`
const profileVersion = `pfv_${suffix}`
const workspaceId = `wsp_${suffix}`
const correlation = { requestId: `req_${suffix}`, traceId: `trc_${suffix}` }
const version = {
  profileId,
  profileVersionId: profileVersion,
  version: 2,
  revision: 3,
  schemaVersion: 1,
  contentDigest: `sha256:${'a'.repeat(64)}`,
  lifecycle: 'published',
  createdAt: '2026-10-07T00:00:00.000Z',
  lifecycleMetadata: {},
}
async function fixture(
  options: {
    lifecycle?: string
    ownership?: string
    resolution?: Record<string, unknown>
    status?: number
  } = {}
) {
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const requests: { operation: string; parameters: Record<string, unknown> }[] = []
  const scopes: string[][] = []
  return {
    requests,
    scopes,
    resolveControlPlaneScope: async () => ({ workspaceId }),
    now: () => Date.parse('2026-10-07T06:00:00.000Z'),
    environment: {
      NODE_ENV: 'production',
      CONTROL_PLANE_ORIGIN: 'https://cp.example',
      CONTROL_PLANE_SIGNING_KEY: JSON.stringify(
        await crypto.subtle.exportKey('jwk', key.privateKey)
      ),
      CONTROL_PLANE_SIGNING_KEY_ID: 'test-profile-pin',
      CONTROL_PLANE_SIGNING_ISSUER: 'https://adea.example',
    },
    fetch: (async (_url, init) => {
      const jwt = new Headers(init?.headers).get('authorization')!.split(' ')[1]!
      scopes.push(JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).scopes)
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      const context = {
        contractVersion: body.contractVersion,
        requestId: body.requestId,
        correlation: body.correlation,
      }
      if (body.operation === 'catalog.profile.get')
        return Response.json({
          ...context,
          data: {
            profile: {
              profileId,
              displayName: 'Engineer',
              ownership: { scope: 'workspace', workspaceId: options.ownership ?? workspaceId },
              readOnly: false,
              createdAt: version.createdAt,
            },
            versions: [],
            version: {
              ...version,
              lifecycle: options.lifecycle ?? 'published',
              definition: { secretCanary: 'private-profile-body' },
            },
          },
        })
      if (options.status)
        return Response.json(
          {
            ...context,
            error: {
              code: 'PROFILE_APPROVAL_REJECTED',
              message: 'private-provider-message',
              class: 'authorization',
              source: 'policy',
              retryable: false,
            },
          },
          { status: options.status }
        )
      const { createdAt: _created, lifecycleMetadata: _metadata, ...resolved } = version
      return Response.json({
        ...context,
        data: {
          profile: { ...resolved, ...options.resolution },
          skillVersionIds: [`skv_${suffix}`],
        },
      })
    }) as typeof fetch,
  }
}

describe('immutable public AgentProfile adoption', () => {
  test('resolves the exact pin and returns only provenance metadata', async () => {
    const deps = await fixture()
    const result = await resolveAgentProfilePin({ profileId, profileVersion }, correlation, deps)
    expect(result).toEqual({
      profileId,
      profileVersion,
      contentDigest: version.contentDigest,
      catalogRevision: 3,
      schemaVersion: 1,
      skillVersionIds: [`skv_${suffix}`],
    })
    expect(deps.requests.map((item) => [item.operation, item.parameters])).toEqual([
      ['catalog.profile.get', { profileId, profileVersionId: profileVersion }],
      ['profile.resolve', { profileId, profileVersionId: profileVersion }],
    ])
    expect(JSON.stringify(result)).not.toContain('private-profile-body')
    expect(deps.scopes).toEqual([['catalog:read'], ['profile:resolve']])
  })
  test('refuses deprecated, revoked, draft and superseded versions without resolving', async () => {
    for (const lifecycle of ['deprecated', 'revoked', 'draft', 'superseded']) {
      const deps = await fixture({ lifecycle })
      await expect(
        resolveAgentProfilePin({ profileId, profileVersion }, correlation, deps)
      ).rejects.toThrow()
      expect(deps.requests).toHaveLength(1)
    }
  })
  test('rejects foreign ownership and mismatched immutable resolution', async () => {
    for (const options of [
      { ownership: `wsp_${'0'.repeat(26)}` },
      { resolution: { profileVersionId: `pfv_${'0'.repeat(26)}` } },
      { resolution: { contentDigest: `sha256:${'b'.repeat(64)}` } },
      { resolution: { revision: 4 } },
    ]) {
      const deps = await fixture(options)
      await expect(
        resolveAgentProfilePin({ profileId, profileVersion }, correlation, deps)
      ).rejects.toThrow()
    }
  })
  test('requires public approval without echoing provider text', async () => {
    const deps = await fixture({ status: 403 })
    await expect(
      resolveAgentProfilePin({ profileId, profileVersion }, correlation, deps)
    ).rejects.toMatchObject({ code: 'PROFILE_APPROVAL_REJECTED', status: 403 })
  })
})

const agent: AgentSummary = {
  id: 'agent-uuid',
  workspaceId: 'workspace-uuid',
  name: 'Engineer',
  lifecycleState: 'active',
  profile: { id: profileId, version: profileVersion, state: 'available', revision: 7 },
  presentationMetadata: {},
  createdAt: version.createdAt,
  updatedAt: version.createdAt,
}
const selection = { profileId, profileVersion, expectedRevision: 7 }
function request(body: unknown = selection) {
  return new Request('https://adea.example/api/profile', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
async function routeFixture(
  options: {
    role?: 'owner' | 'member' | 'outsider'
    lifecycle?: string
    missingAgent?: boolean
    status?: number
  } = {}
) {
  const hop = await fixture(options)
  const writes: ApiAgentProfileInput[] = []
  const principal = { kind: 'user' as const, userId: 'user-uuid' }
  return {
    requests: hop.requests,
    writes,
    dependencies: {
      guard: () => null,
      resolvePrincipal: async () => ({
        principal,
        clearTemporaryCredential: false,
        sessionRotated: false,
        temporary: false,
      }),
      authorize: async (_principal: unknown, permission: string) =>
        options.role !== 'outsider' &&
        (permission === 'workspace.read' || options.role !== 'member'),
      canManage: async () => true,
      hop: () => hop,
      json: (body: unknown, _resolution: unknown, _request: Request, init?: ResponseInit) =>
        Response.json(body, init),
      failure: (_request: Request, code: string, message: string, status: number) =>
        Response.json({ code, message }, { status }),
      invalid: () => Response.json({ code: 'invalid_request' }, { status: 400 }),
      unavailable: (_request: Request, status = 404) =>
        Response.json({ code: 'workspace_unavailable' }, { status }),
      read: async () => (options.missingAgent ? null : agent),
      persist: async (
        _workspaceId: string,
        _agentId: string,
        _principal: unknown,
        input: ApiAgentProfileInput
      ) => {
        writes.push(input)
        return agent
      },
    },
  }
}

describe('authorized profile mutation route', () => {
  test('writes only an approved exact reference with the expected revision', async () => {
    const deps = await routeFixture()
    const response = await handleAgentProfileChange(
      request(),
      agent.workspaceId,
      agent.id,
      deps.dependencies
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(deps.writes).toEqual([selection])
    expect(JSON.stringify(await response.json())).not.toContain('private-profile-body')
  })
  test('refuses unauthorized or unknown Agents before catalog access', async () => {
    for (const [options, status] of [
      [{ role: 'member' as const }, 403],
      [{ role: 'outsider' as const }, 404],
      [{ missingAgent: true }, 404],
    ] as const) {
      const deps = await routeFixture(options)
      expect(
        (await handleAgentProfileChange(request(), agent.workspaceId, agent.id, deps.dependencies))
          .status
      ).toBe(status)
      expect(deps.requests).toHaveLength(0)
      expect(deps.writes).toHaveLength(0)
    }
  })
  test('rejects caller-asserted state, malformed references and stale edits', async () => {
    for (const [input, status] of [
      [{ ...selection, profileState: 'available' }, 400],
      [{ ...selection, profileVersion: 'latest' }, 400],
      [{ profileId, profileVersion }, 400],
      [{ ...selection, expectedRevision: 6 }, 409],
    ] as const) {
      const deps = await routeFixture()
      expect(
        (
          await handleAgentProfileChange(
            request(input),
            agent.workspaceId,
            agent.id,
            deps.dependencies
          )
        ).status
      ).toBe(status)
      expect(deps.requests).toHaveLength(0)
      expect(deps.writes).toHaveLength(0)
    }
  })
  test('lifecycle, approval and outage refusals never persist a pin', async () => {
    for (const options of [
      { lifecycle: 'revoked' },
      { lifecycle: 'deprecated' },
      { status: 403 },
      { status: 503 },
    ]) {
      const deps = await routeFixture(options)
      const response = await handleAgentProfileChange(
        request(),
        agent.workspaceId,
        agent.id,
        deps.dependencies
      )
      expect(response.ok).toBe(false)
      expect(deps.writes).toHaveLength(0)
      expect(JSON.stringify(await response.json())).not.toContain('private-provider-message')
    }
  })
})
