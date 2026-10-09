import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  ManagementAuthorityError,
  type ManagementCurrentAuthorityRequest,
} from '@adea-ai/types/management'

import {
  createControlPlaneManagementCurrentAuthority,
  PI_DURABLE_MANAGEMENT_CURRENT_OPERATION,
  PI_DURABLE_MANAGEMENT_CURRENT_PATH,
} from '../src/server/management-authority-current'
import {
  MANAGEMENT_NOW,
  MANAGEMENT_PROJECT,
  managementAuthorityDecision,
} from './helpers/management-authority'

const TOKEN = 'fixture-management-current-token'
const WORKSPACE = 'wsp_01JABCDEF0123456789ABCDEFG'

type Seen = Readonly<{ authorization: string; body: Record<string, unknown>; path: string }>

describe('Control API management current authority client (#1215)', () => {
  let server: ReturnType<typeof Bun.serve>
  let seen: Seen[] = []
  let mode: 'ok' | 'rejected' | 'malformed' | 'truthy' = 'ok'
  let request: ManagementCurrentAuthorityRequest

  beforeAll(async () => {
    server = Bun.serve({
      fetch: async (incoming) => {
        const body = (await incoming.json()) as Record<string, unknown>
        seen.push({
          authorization: incoming.headers.get('authorization') ?? '',
          body,
          path: new URL(incoming.url).pathname,
        })
        if (mode === 'rejected') return new Response('{"code":"NOPE"}', { status: 503 })
        if (mode === 'malformed') return new Response('not-json')
        const correlation = body.correlation as Record<string, unknown>
        if (mode === 'truthy')
          return Response.json({
            correlation,
            data: { granted: true },
            requestId: body.requestId,
          })
        return Response.json({
          correlation,
          data: { asserted: true },
          requestId: body.requestId,
        })
      },
      port: 0,
    })
    const decision = await managementAuthorityDecision({
      input: { name: 'Renamed' },
      operation: 'project.update',
      targetId: MANAGEMENT_PROJECT,
    })
    request = {
      approval: decision.approval,
      audienceRef: decision.audienceRef,
      authorityRef: decision.authorityRef,
      authorityRevision: decision.authorityRevision,
      binding: decision.binding,
      canonicalRequest: {
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        executionId: 'exe_01JABCDEF0123456789ABCDEFG',
        toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
      },
      decisionId: decision.decisionId,
      intentId: decision.intentId,
      leadAgentId: decision.leadAgentId,
      now: MANAGEMENT_NOW,
      planRef: decision.planRef,
      planRevision: decision.planRevision,
      principal: decision.principal,
    }
  })

  afterAll(() => {
    server.stop(true)
  })

  function client(fetchImpl?: typeof fetch) {
    return createControlPlaneManagementCurrentAuthority({
      credential: async () => ({ token: TOKEN, workspaceId: WORKSPACE }),
      environment: { CONTROL_PLANE_ORIGIN: `http://127.0.0.1:${server.port}` },
      now: () => MANAGEMENT_NOW,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
  }

  test('sends the real read envelope with the opaque canonical request and boundary', async () => {
    seen = []
    mode = 'ok'
    await client()(request, 'effect')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.path).toBe(PI_DURABLE_MANAGEMENT_CURRENT_PATH)
    expect(seen[0]?.authorization).toBe(`Bearer ${TOKEN}`)
    expect(seen[0]?.body).toMatchObject({
      caller: { servicePrincipalId: expect.any(String) },
      operation: PI_DURABLE_MANAGEMENT_CURRENT_OPERATION,
      parameters: {
        boundary: 'effect',
        request: request.canonicalRequest,
      },
      workspaceId: WORKSPACE,
    })
  })

  test('is repeatable: the same assertion may run again without consumption', async () => {
    seen = []
    mode = 'ok'
    await client()(request, 'admission')
    await client()(request, 'effect')
    expect(seen).toHaveLength(2)
    expect(seen.map((entry) => (entry.body.parameters as { boundary: string }).boundary)).toEqual([
      'admission',
      'effect',
    ])
  })

  test('rejection, malformed and truthy answers fail closed', async () => {
    for (const current of ['rejected', 'malformed', 'truthy'] as const) {
      mode = current
      await expect(client()(request, 'effect')).rejects.toBeInstanceOf(ManagementAuthorityError)
    }
    mode = 'ok'
  })

  test('a missing canonical request, credential or origin fails closed before any hop', async () => {
    let fetches = 0
    const counting = (async () => {
      fetches++
      return Response.json({})
    }) as unknown as typeof fetch
    const { canonicalRequest: _canonicalRequest, ...withoutCanonical } = request
    void _canonicalRequest
    await expect(
      client(counting)(withoutCanonical as ManagementCurrentAuthorityRequest, 'effect')
    ).rejects.toBeInstanceOf(ManagementAuthorityError)
    await expect(
      createControlPlaneManagementCurrentAuthority({
        credential: async () => {
          throw new Error('unmapped')
        },
        environment: { CONTROL_PLANE_ORIGIN: `http://127.0.0.1:${server.port}` },
      })(request, 'effect')
    ).rejects.toBeInstanceOf(ManagementAuthorityError)
    await expect(
      createControlPlaneManagementCurrentAuthority({
        credential: async () => ({ token: TOKEN, workspaceId: WORKSPACE }),
        environment: {},
        now: () => MANAGEMENT_NOW,
      })(request, 'effect')
    ).rejects.toBeInstanceOf(ManagementAuthorityError)
    expect(fetches).toBe(0)
  })

  test('an unknown boundary is refused without a hop', async () => {
    let fetches = 0
    const counting = (async () => {
      fetches++
      return Response.json({})
    }) as unknown as typeof fetch
    await expect(client(counting)(request, 'unknown' as never)).rejects.toBeInstanceOf(
      ManagementAuthorityError
    )
    expect(fetches).toBe(0)
  })
})
