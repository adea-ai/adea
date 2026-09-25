import { describe, expect, test } from 'bun:test'

import { workspaceJsonResponse, workspaceStreamResponse } from '../src/server/workspace-response'

const resolution = {
  clearTemporaryCredential: false,
  createdCredential: `adea_tmp_${'a'.repeat(43)}`,
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  principal: { kind: 'user' as const, userId: 'temporary-user' },
  sessionRotated: false,
  temporary: true,
}

describe('workspace response credentials', () => {
  test('sets an HttpOnly browser cookie but returns no desktop cookie', () => {
    const browser = workspaceJsonResponse(
      { ok: true },
      resolution,
      new Request('http://localhost/api/workspaces/bootstrap', { method: 'POST' })
    )
    expect(browser.headers.get('set-cookie')).toContain('agent_hq_temporary_session=adea_tmp_')
    expect(browser.headers.get('set-cookie')).toContain('HttpOnly')

    const desktop = workspaceJsonResponse(
      { ok: true },
      resolution,
      new Request('http://localhost/api/workspaces/bootstrap', {
        headers: {
          origin: 'http://127.0.0.1:1420',
          'x-adea-client': 'desktop',
        },
        method: 'POST',
      })
    )
    expect(desktop.headers.get('set-cookie')).toBeNull()
    expect(desktop.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:1420')
  })
})

function desktopRequest(): Request {
  return new Request('http://localhost/api/marketplace/catalog', {
    headers: { origin: 'http://127.0.0.1:4789', 'x-adea-client': 'desktop' },
    method: 'POST',
  })
}

describe('workspace streamed responses', () => {
  test('forwards chunks while the upstream body is still open', async () => {
    // The catalog is tens of megabytes. If this helper ever buffers the body
    // (for example by awaiting `upstream.text()` or `upstream.json()`), the
    // first chunk cannot arrive before the upstream closes, and the worker
    // holds the whole payload twice — which is what returned a Cloudflare
    // 1102 to a fresh client with no cached snapshot.
    let releaseSecondChunk: (() => void) | undefined
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"catalogId":'))
          return new Promise<void>((resolve) => {
            releaseSecondChunk = () => {
              controller.enqueue(new TextEncoder().encode('"catalog-1"}'))
              controller.close()
              resolve()
            }
          })
        },
      }),
      { headers: { 'content-type': 'application/json' } }
    )

    const streamed = workspaceStreamResponse(upstream, resolution, desktopRequest())
    expect(streamed.headers.get('content-type')).toContain('application/json')
    expect(streamed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4789')
    expect(streamed.headers.get('set-cookie')).toBeNull()

    const reader = streamed.body?.getReader()
    expect(reader).toBeDefined()
    const firstChunk = await Promise.race([
      reader!.read(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ])
    expect(firstChunk).not.toBe('timeout')
    expect(
      new TextDecoder().decode((firstChunk as ReadableStreamReadResult<Uint8Array>).value)
    ).toBe('{"catalogId":')

    releaseSecondChunk?.()
    expect(new TextDecoder().decode((await reader!.read()).value)).toBe('"catalog-1"}')
  })

  test('preserves the upstream status so a rejected read still fails', async () => {
    const streamed = workspaceStreamResponse(
      new Response('{"code":"CONTROL_PLANE_UNAVAILABLE"}', {
        headers: { 'content-type': 'application/json' },
        status: 503,
      }),
      resolution,
      desktopRequest()
    )
    expect(streamed.status).toBe(503)
    expect(await streamed.text()).toBe('{"code":"CONTROL_PLANE_UNAVAILABLE"}')
  })
})
