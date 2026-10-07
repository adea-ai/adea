import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { postControlPlane, readEnvelope } from '../src/server/control-plane-client'

const requestId = 'req_01JABCDEF0123456789ABCDEFG'
const traceId = 'trc_01JABCDEF0123456789ABCDEFG'
const credential = {
  token: 'inert-test-service-credential',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
}
const path = '/v1/catalog/skills/list'
const operation = 'catalog.skill.list'
let logged: string[] = []
let restoreLog: () => void
beforeEach(() => {
  logged = []
  const log = spyOn(console, 'warn').mockImplementation((line) => logged.push(String(line)))
  restoreLog = () => log.mockRestore()
})
afterEach(() => restoreLog())
const request = () =>
  readEnvelope(credential, { requestId, traceId }, operation, { limit: 100 }, Date.UTC(2026, 9, 7))
const response = () => ({
  contractVersion: { major: 3, minor: 0 },
  requestId,
  correlation: { traceId },
  data: { items: [], page: {} },
})

function hop(answer: () => Response, origin = 'https://control-plane.example') {
  return {
    environment: { CONTROL_PLANE_ORIGIN: origin, NODE_ENV: 'production' },
    fetch: (async () => answer()) as typeof fetch,
    resolveControlPlaneScope: async () => credential,
  }
}

describe('published SDK administration boundary', () => {
  test('carries request and trace identity with a bounded, nonredirecting service hop', async () => {
    let sent: RequestInit | undefined
    const dependencies = hop(() => Response.json(response()))
    dependencies.fetch = (async (_url, init) => {
      sent = init
      return Response.json(response())
    }) as typeof fetch
    expect(await postControlPlane(credential, path, request(), dependencies, operation)).toEqual({
      items: [],
      page: {},
    })
    expect(new Headers(sent?.headers).get('x-correlation-id')).toBe(traceId)
    expect(new Headers(sent?.headers).get('x-request-id')).toBe(requestId)
    expect(sent?.redirect).toBe('error')
    expect(sent?.signal).toBeInstanceOf(AbortSignal)
  })

  test('rejects incompatible, malformed, and miscorrelated success responses', async () => {
    for (const invalid of [
      { ...response(), contractVersion: { major: 99, minor: 0 } },
      { ...response(), data: { items: 'not-an-array', page: {} } },
      { ...response(), requestId: 'req_01JABCDEF0123456789ABCDEFH' },
      { ...response(), correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFH' } },
    ]) {
      await expect(
        postControlPlane(
          credential,
          path,
          request(),
          hop(() => Response.json(invalid)),
          operation
        )
      ).rejects.toMatchObject({ code: 'CONTROL_PLANE_UNAVAILABLE', status: 503 })
    }
  })

  test('rejects foreign scopes, wrong operations and insecure origins before sending', async () => {
    let calls = 0
    const dependencies = hop(() => {
      calls += 1
      return Response.json(response())
    })
    for (const body of [
      { ...request(), workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
      { ...request(), operation: 'catalog.profile.list' },
      { ...request(), caller: { servicePrincipalId: 'svc_other' } },
      { ...request(), parameters: { limit: 100, privatePath: '/private/path' } },
    ]) {
      await expect(
        postControlPlane(credential, path, body, dependencies, operation)
      ).rejects.toMatchObject({ code: 'CONTROL_PLANE_UNAVAILABLE' })
    }
    for (const origin of [
      'http://remote.example',
      'https://user:password@control-plane.example',
      'https://control-plane.example/other-service',
    ]) {
      await expect(
        postControlPlane(
          credential,
          path,
          request(),
          { ...dependencies, environment: { CONTROL_PLANE_ORIGIN: origin } },
          operation
        )
      ).rejects.toMatchObject({ code: 'CONTROL_PLANE_UNAVAILABLE' })
    }
    expect(calls).toBe(0)
  })

  test('refuses a secret-bearing response without logging its validation details', async () => {
    const secret = 'inert-secret-canary-never-return'
    const body = {
      ...response(),
      data: { items: [], page: {}, secret },
    }
    await expect(
      postControlPlane(
        credential,
        path,
        request(),
        hop(() => Response.json(body)),
        operation
      )
    ).rejects.toMatchObject({ code: 'CONTROL_PLANE_UNAVAILABLE' })
    expect(logged.join(' ')).not.toContain(secret)
    expect(logged.join(' ')).not.toContain(credential.token)
  })

  test('normalizes authentication, transport, and deadline failures without upstream text', async () => {
    const secret = 'inert-rejection-canary-never-return'
    const rejected = {
      ...response(),
      data: undefined,
      error: {
        class: 'authentication',
        code: 'SERVICE_CREDENTIAL_REVOKED',
        message: secret,
        retryable: false,
        source: 'auth',
      },
    }
    const dependencies = hop(() => Response.json(rejected, { status: 401 }))
    await expect(
      postControlPlane(credential, path, request(), dependencies, operation)
    ).rejects.toMatchObject({
      code: 'CONTROL_PLANE_UNAVAILABLE',
      message: 'Control Plane is unavailable',
      status: 503,
    })
    for (const failure of [new Error(secret), new DOMException(secret, 'TimeoutError')]) {
      dependencies.fetch = (async () => {
        throw failure
      }) as typeof fetch
      await expect(
        postControlPlane(credential, path, request(), dependencies, operation)
      ).rejects.toMatchObject({
        code: 'CONTROL_PLANE_UNAVAILABLE',
        message: 'Control Plane is unavailable',
        status: 503,
      })
    }
    expect(logged.join(' ')).not.toContain(secret)
    expect(logged.join(' ')).not.toContain(credential.token)
  })

  test('aborts a stalled service request at the configured deadline', async () => {
    let aborted = false
    const dependencies = hop(() => Response.json(response()))
    dependencies.fetch = ((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(init.signal?.reason)
        })
      })) as typeof fetch
    await expect(
      postControlPlane(credential, path, request(), dependencies, operation)
    ).rejects.toMatchObject({ code: 'CONTROL_PLANE_UNAVAILABLE', status: 503 })
    expect(aborted).toBe(true)
  }, 10_000)
})
