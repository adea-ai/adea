import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ManagementAuthorityError } from '@adea-ai/types/management'

import { createManagementCurrentAuthority } from '../src/server/management-authority-current'
import { MANAGEMENT_PROJECT, managementAuthorityDecision } from './helpers/management-authority'

const TOKEN = 'fixture-current-authority-token'

async function fixtureRequest() {
  const decision = await managementAuthorityDecision({
    input: { name: 'Renamed' },
    operation: 'project.update',
    targetId: MANAGEMENT_PROJECT,
  })
  return {
    approval: decision.approval,
    audienceRef: decision.audienceRef,
    authorityRef: decision.authorityRef,
    authorityRevision: decision.authorityRevision,
    binding: decision.binding,
    decisionId: decision.decisionId,
    intentId: decision.intentId,
    leadAgentId: decision.leadAgentId,
    now: Date.now(),
    planRef: decision.planRef,
    planRevision: decision.planRevision,
    principal: decision.principal,
  }
}

type Seen = Readonly<{ authorization: string; body: Record<string, unknown> }>

describe('CP current-authority client (#1215)', () => {
  let server: ReturnType<typeof Bun.serve>
  let seen: Seen[] = []
  let mode: 'ok' | 'forbidden' | 'malformed' | 'truthy' | 'slow' = 'ok'

  beforeAll(() => {
    server = Bun.serve({
      fetch: async (request) => {
        seen.push({
          authorization: request.headers.get('authorization') ?? '',
          body: (await request.json()) as Record<string, unknown>,
        })
        if (mode === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 200))
          return Response.json({ asserted: true })
        }
        if (mode === 'forbidden') return Response.json({ asserted: false }, { status: 403 })
        if (mode === 'malformed') return new Response('not-json', { status: 200 })
        if (mode === 'truthy') return Response.json({ allowed: true }, { status: 200 })
        return Response.json({ asserted: true })
      },
      port: 0,
    })
  })

  afterAll(() => {
    server.stop(true)
  })

  function client(timeoutMs = 1_000) {
    return createManagementCurrentAuthority(
      {
        PI_LEAD_MANAGEMENT_AUTHORITY_TOKEN: TOKEN,
        PI_LEAD_MANAGEMENT_AUTHORITY_URL: `http://127.0.0.1:${server.port}/assert-current`,
      },
      { timeoutMs }
    )
  }

  test('asserts current authority on the configured endpoint with the exact binding', async () => {
    seen = []
    mode = 'ok'
    await client()(await fixtureRequest())
    expect(seen).toHaveLength(1)
    expect(seen[0]?.authorization).toBe(`Bearer ${TOKEN}`)
    expect(seen[0]?.body).toMatchObject({
      binding: {
        operation: 'project.update',
        workspaceId: '0f3a2e1c-0000-4000-8000-000000000001',
      },
      schemaVersion: 'adea-management-current/v1',
    })
    expect(seen[0]?.body).not.toHaveProperty('allowed')
  })

  test('revocation or any non-2xx answer fails closed', async () => {
    mode = 'forbidden'
    await expect(client()(await fixtureRequest())).rejects.toBeInstanceOf(ManagementAuthorityError)
  })

  test('an unreachable or unconfigured owner fails closed', async () => {
    mode = 'ok'
    const unconfigured = createManagementCurrentAuthority({})
    await expect(unconfigured(await fixtureRequest())).rejects.toBeInstanceOf(
      ManagementAuthorityError
    )
    const badUrl = createManagementCurrentAuthority(
      {
        PI_LEAD_MANAGEMENT_AUTHORITY_TOKEN: TOKEN,
        PI_LEAD_MANAGEMENT_AUTHORITY_URL: 'http://127.0.0.1:1/assert-current',
      },
      { timeoutMs: 100 }
    )
    await expect(badUrl(await fixtureRequest())).rejects.toBeInstanceOf(ManagementAuthorityError)
  })

  test('a malformed or caller-truthy response is never accepted as a grant', async () => {
    mode = 'malformed'
    await expect(client()(await fixtureRequest())).rejects.toBeInstanceOf(ManagementAuthorityError)
    mode = 'truthy'
    await expect(client()(await fixtureRequest())).rejects.toBeInstanceOf(ManagementAuthorityError)
  })

  test('a parked endpoint times out into a typed refusal', async () => {
    mode = 'slow'
    await expect(client(50)(await fixtureRequest())).rejects.toBeInstanceOf(
      ManagementAuthorityError
    )
    mode = 'ok'
  })
})
