import { describe, expect, test } from 'bun:test'
import type { AgentSummary } from '@adea-ai/types'
import {
  AGENT_PROFILE_READ_LIMITS,
  withAgentProfileAvailability,
} from '../src/server/agent-profile-availability'

const suffix = '01JABCDEF0123456789ABCDEFG'
const profileId = `prf_${suffix}`
const profileVersion = `pfv_${suffix}`
const workspaceId = `wsp_${suffix}`
const correlation = { requestId: `req_${suffix}`, traceId: `trc_${suffix}` }
const now = Date.parse('2026-10-07T06:00:00.000Z')
const agent: AgentSummary = {
  id: 'agent-uuid',
  workspaceId: 'workspace-uuid',
  name: 'Engineer',
  lifecycleState: 'active',
  profile: { id: profileId, version: profileVersion, state: 'available', revision: 7 },
  presentationMetadata: {},
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
}

async function fixture(
  options: { lifecycle?: string; status?: number; missing?: boolean; resolveOnly?: boolean } = {}
) {
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const requests: Record<string, unknown>[] = []
  let active = 0
  let maximumActive = 0
  return {
    requests,
    maximumActive: () => maximumActive,
    now: () => now,
    resolveControlPlaneScope: async () => ({ workspaceId }),
    environment: {
      NODE_ENV: 'production',
      CONTROL_PLANE_ORIGIN: 'https://cp.example',
      CONTROL_PLANE_SIGNING_KEY: JSON.stringify(
        await crypto.subtle.exportKey('jwk', key.privateKey)
      ),
      CONTROL_PLANE_SIGNING_KEY_ID: 'test-profile-read',
      CONTROL_PLANE_SIGNING_ISSUER: 'https://adea.example',
    },
    fetch: (async (_url, init) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      const context = {
        contractVersion: body.contractVersion,
        requestId: body.requestId,
        correlation: body.correlation,
      }
      if (options.status && (!options.resolveOnly || body.operation === 'profile.resolve'))
        return Response.json(
          {
            ...context,
            error: {
              code: 'PROFILE_READ_REJECTED',
              message: 'private-provider-canary',
              class: 'authorization',
              source: 'policy',
              retryable: false,
            },
          },
          { status: options.status }
        )
      const version = {
        profileId: body.parameters.profileId,
        profileVersionId: body.parameters.profileVersionId,
        version: 2,
        revision: 3,
        schemaVersion: 1,
        contentDigest: `sha256:${'a'.repeat(64)}`,
        lifecycle: options.lifecycle ?? 'published',
      }
      if (body.operation === 'catalog.profile.get')
        return Response.json({
          ...context,
          data: {
            profile: {
              profileId: version.profileId,
              displayName: 'Engineer',
              ownership: { scope: 'workspace', workspaceId },
              readOnly: false,
              createdAt: new Date(now).toISOString(),
            },
            versions: [],
            ...(options.missing
              ? {}
              : {
                  version: {
                    ...version,
                    createdAt: new Date(now).toISOString(),
                    lifecycleMetadata: {},
                    definition: { secretCanary: 'private-profile-canary' },
                  },
                }),
          },
        })
      return Response.json({
        ...context,
        data: {
          profile: version,
          skillVersionIds: [`skv_${suffix}`],
        },
      })
    }) as typeof fetch,
  }
}

describe('authoritative exact-pin Agent availability', () => {
  test('checks a shared pin once, preserves every identity/revision and drops private metadata', async () => {
    const deps = await fixture()
    const inputs = [agent, { ...agent, id: 'second-agent' }]
    const result = await withAgentProfileAvailability(inputs, correlation, deps)
    expect(deps.requests).toHaveLength(2)
    expect(deps.requests.every((request) => JSON.stringify(request).includes(profileVersion))).toBe(
      true
    )
    expect(result.map((item) => item.id)).toEqual(inputs.map((item) => item.id))
    expect(result[0]!.profile).toEqual({ ...agent.profile, checkedAt: new Date(now).toISOString() })
    expect(agent.profile).not.toHaveProperty('checkedAt')
    expect(JSON.stringify(result)).not.toMatch(/private-profile|skillVersionIds|contentDigest/)
  })
  test('projects exact lifecycle/approval/compatibility refusals without changing the pin', async () => {
    for (const [options, state] of [
      [{ lifecycle: 'deprecated' }, 'deprecated'],
      [{ lifecycle: 'revoked' }, 'revoked'],
      [{ lifecycle: 'draft' }, 'unapproved'],
      [{ lifecycle: 'superseded' }, 'unapproved'],
      [{ missing: true }, 'missing'],
      [{ status: 404 }, 'missing'],
      [{ status: 403 }, 'unapproved'],
      [{ status: 422 }, 'incompatible'],
      [{ status: 422, resolveOnly: true }, 'incompatible'],
      [{ status: 403, resolveOnly: true }, 'unapproved'],
      [{ status: 503 }, 'unavailable'],
    ] as const) {
      const deps = await fixture(options)
      const [result] = await withAgentProfileAvailability([agent], correlation, deps)
      expect(result!.profile).toEqual({
        ...agent.profile,
        state,
        checkedAt: new Date(now).toISOString(),
      })
      expect(JSON.stringify(result)).not.toContain('private-provider-canary')
    }
  })
  test('a legacy/malformed reference is blocked without calling the catalog', async () => {
    const deps = await fixture()
    const [result] = await withAgentProfileAvailability(
      [{ ...agent, profile: { id: 'engineer', version: 'latest', state: 'available' } }],
      correlation,
      deps
    )
    expect(result!.profile.state).toBe('incompatible')
    expect(deps.requests).toHaveLength(0)
  })
  test('limits distinct pins and concurrency; unchecked pins never inherit available', async () => {
    const deps = await fixture()
    const inputs = Array.from(
      { length: AGENT_PROFILE_READ_LIMITS.distinctPins + 2 },
      (_, index) => ({
        ...agent,
        id: `agent-${index}`,
        profile: {
          ...agent.profile,
          version: `pfv_${String(index).padStart(26, '0')}`,
        },
      })
    )
    const results = await withAgentProfileAvailability(inputs, correlation, deps)
    expect(results.slice(0, 32).every((item) => item.profile.state === 'available')).toBe(true)
    expect(results.slice(32).map((item) => item.profile.state)).toEqual([
      'unavailable',
      'unavailable',
    ])
    expect(deps.requests).toHaveLength(64)
    expect(deps.maximumActive()).toBeLessThanOrEqual(4)
  })
  test('request cancellation bounds scope work and ignores a late result', async () => {
    const deps = await fixture()
    const controller = new AbortController()
    let release!: (value: { workspaceId: string }) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = withAgentProfileAvailability(
      [agent],
      correlation,
      {
        ...deps,
        resolveControlPlaneScope: () => {
          started()
          return new Promise((resolve) => {
            release = resolve
          })
        },
      },
      controller.signal
    )
    await entered
    controller.abort()
    const [result] = await pending
    expect(result!.profile.state).toBe('unavailable')
    release({ workspaceId })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deps.requests).toHaveLength(0)
    expect(result!.profile.state).toBe('unavailable')
  })
  test('empty inventory never calls scope or catalog', async () => {
    const deps = await fixture()
    expect(await withAgentProfileAvailability([], correlation, deps)).toEqual([])
    expect(deps.requests).toHaveLength(0)
  })

  test('the overall deadline returns unavailable even while scope resolution is stalled', async () => {
    const deps = await fixture()
    let release!: (value: { workspaceId: string }) => void
    const [result] = await withAgentProfileAvailability([agent], correlation, {
      ...deps,
      resolveControlPlaneScope: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })
    expect(result!.profile.state).toBe('unavailable')
    release({ workspaceId })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(deps.requests).toHaveLength(0)
  }, 8_000)
})
