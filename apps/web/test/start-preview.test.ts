import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import lazyComponent from '../src/start-preview/lazy-component'
import forbiddenModuleFixtures from './start-preview-client-denylist.json'
import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import { evaluateEntryAccess } from '../src/lib/entry-access-policy.mjs'
import { createPreviewGateway, isLegacyPath } from '../src/start-preview/gateway.mjs'
import {
  parseWorkspaceSearch,
  stringifyWorkspaceSearch,
} from '../src/start-preview/search-codec.mjs'
import { workspaceSelection } from '../src/start-preview/workspace-selection.mjs'
import {
  forbiddenClientModule,
  PUBLIC_ENV_NAMES,
  PRIVATE_ENV_NAMES,
} from '../start-preview/client-policy.mjs'

const origin = 'https://adea-start.test'
const gate = (
  access: string,
  status = access === 'allowed' ? 200 : access === 'sign-in' ? 401 : 403
) => Response.json({ access }, { status })
const app = () =>
  new Response('<html>workspace</html>', { headers: { 'Content-Type': 'text/html' } })
const request = (path = '/', options: RequestInit = {}) => new Request(`${origin}${path}`, options)

function noStore(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.match(response.headers.get('x-robots-tag'), /noindex/)
}

describe('the existing early-access policy', () => {
  it('does not resolve accounts when no allowlist is configured', async () => {
    assert.equal(
      await evaluateEntryAccess({
        configured: false,
        resolveEmail: () => {
          throw new Error('unexpected')
        },
        isAllowed: () => false,
      }),
      'allowed'
    )
  })
  it('sends missing sessions to sign-in', async () => {
    for (const email of [null, undefined, '']) {
      assert.equal(
        await evaluateEntryAccess({
          configured: true,
          resolveEmail: async () => email,
          isAllowed: () => true,
        }),
        'sign-in'
      )
    }
  })
  it('fails closed when the auth provider is unavailable', async () => {
    assert.equal(
      await evaluateEntryAccess({
        configured: true,
        resolveEmail: async () => {
          throw new Error('private provider detail')
        },
        isAllowed: () => true,
      }),
      'sign-in'
    )
  })
  it('admits an allowed account and rejects another account', async () => {
    for (const allowed of [true, false]) {
      assert.equal(
        await evaluateEntryAccess({
          configured: true,
          resolveEmail: async () => 'person@example.test',
          isAllowed: () => allowed,
        }),
        allowed ? 'allowed' : 'denied'
      )
    }
  })
})

describe('Start preview gateway', () => {
  it('fails closed without its isolated backend binding', async () => {
    let rendered = false
    const response = await createPreviewGateway({
      application: () => {
        rendered = true
        return app()
      },
    })(request())
    assert.equal(response.status, 503)
    assert.equal(rendered, false)
    noStore(response)
  })
  it('checks access before rendering and preserves the public URL and credentials', async () => {
    const order: string[] = []
    const handler = createPreviewGateway({
      backend: async (input) => {
        order.push('gate')
        assert.equal(input.url, `${origin}/api/web-entry`)
        assert.equal(input.method, 'GET')
        assert.equal(input.headers.get('cookie'), 'session=one')
        assert.equal(input.headers.get('authorization'), 'Desktop token')
        assert.equal(input.headers.get('origin'), 'https://untrusted.test')
        assert.equal(input.headers.get('x-forwarded-host'), 'adea-start.test')
        assert.equal(input.headers.get('x-forwarded-proto'), 'https')
        assert.equal(input.redirect, 'manual')
        return gate('allowed')
      },
      application: (input) => {
        order.push('render')
        assert.equal(input.url, `${origin}/?view=chat&scene=home`)
        return app()
      },
    })
    const response = await handler(
      request('/?view=chat&scene=home', {
        headers: {
          Cookie: 'session=one',
          Authorization: 'Desktop token',
          Origin: 'https://untrusted.test',
          'X-Forwarded-Host': 'attacker.test',
        },
      })
    )
    assert.deepEqual(order, ['gate', 'render'])
    noStore(response)
  })
  it('accepts synchronous standard Fetch handlers', async () => {
    const response = await createPreviewGateway({
      backend: () => gate('allowed'),
      application: app,
    })(request())
    assert.equal(response.status, 200)
  })
  it('returns a real redirect for unsigned restricted visitors', async () => {
    const response = await createPreviewGateway({
      backend: async () => gate('sign-in'),
      application: () => {
        throw new Error('must not render')
      },
    })(request())
    assert.equal(response.status, 307)
    assert.equal(response.headers.get('location'), '/auth/sign-in')
    noStore(response)
  })
  it('preserves the existing early-access document for denied users', async () => {
    const paths: string[] = []
    const response = await createPreviewGateway({
      backend: async (input) => {
        paths.push(new URL(input.url).pathname)
        return paths.length === 1 ? gate('denied') : new Response('Existing early-access notice')
      },
      application: () => {
        throw new Error('must not render')
      },
    })(request())
    assert.deepEqual(paths, ['/api/web-entry', '/'])
    assert.equal(await response.text(), 'Existing early-access notice')
    noStore(response)
  })
  it('does not follow upstream auth redirects or discard multiple cookies', async () => {
    const response = await createPreviewGateway({
      backend: async (input) => {
        assert.equal(input.redirect, 'manual')
        const headers = new Headers({ Location: '/auth/sign-in?next=%2F' })
        headers.append('Set-Cookie', 'first=one; Path=/; HttpOnly')
        headers.append('Set-Cookie', 'second=two; Path=/; Secure')
        return new Response(null, { status: 302, headers })
      },
      application: app,
    })(request('/auth/callback?code=opaque&state=opaque'))
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/auth/sign-in?next=%2F')
    assert.deepEqual(response.headers.getSetCookie(), [
      'first=one; Path=/; HttpOnly',
      'second=two; Path=/; Secure',
    ])
    noStore(response)
  })
  it('carries gate cookie rotation onto the final response', async () => {
    const response = await createPreviewGateway({
      backend: async () => {
        const gateResponse = gate('allowed')
        gateResponse.headers.append('Set-Cookie', 'rotated=one; Path=/; HttpOnly')
        gateResponse.headers.append('Set-Cookie', 'metadata=two; Path=/; HttpOnly')
        return gateResponse
      },
      application: app,
    })(request())
    assert.equal(response.headers.getSetCookie().length, 2)
  })
  it('preserves methods, bodies, origins and the full OAuth query string', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await createPreviewGateway({
        backend: async (input) => {
          assert.equal(input.method, method)
          assert.equal(input.url, `${origin}/api/tasks?x=1&x=2`)
          assert.equal(input.headers.get('origin'), 'https://untrusted.test')
          assert.equal(await input.text(), '{"title":"safe payload"}')
          return Response.json({ ok: true })
        },
        application: app,
      })(
        request('/api/tasks?x=1&x=2', {
          method,
          body: '{"title":"safe payload"}',
          headers: { Origin: 'https://untrusted.test' },
        })
      )
      assert.equal(response.status, 200)
      noStore(response)
    }
  })
  it('does not invent an Origin for a request that lacks one', async () => {
    await createPreviewGateway({
      backend: async (input) => {
        assert.equal(input.headers.get('origin'), null)
        return new Response(null, { status: 403 })
      },
      application: app,
    })(request('/api/auth/sign-out', { method: 'POST' }))
  })
  it('does not let Connection remove authentication or CSRF headers', async () => {
    let reached = false
    const response = await createPreviewGateway({
      backend: async () => {
        reached = true
        return gate('allowed')
      },
      application: app,
    })(request('/', { headers: { Connection: 'Origin', Origin: 'https://untrusted.test' } }))
    assert.equal(response.status, 503)
    assert.equal(reached, false)
  })
  it('does not buffer event-stream bodies', async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'))
      },
    })
    const response = await createPreviewGateway({
      backend: async () =>
        new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }),
      application: app,
    })(request('/api/events'))
    assert.equal(response.body, source)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    noStore(response)
    await response.body.cancel()
  })
  it('recognizes prefix boundaries without treating lookalikes as backend routes', () => {
    for (const path of [
      '/icon.svg',
      '/api',
      '/api/auth/callback',
      '/auth',
      '/auth/sign-in',
      '/_next/static/file.js',
    ])
      assert.equal(isLegacyPath(path), true)
    for (const path of ['/apiary', '/authentication', '/_nextish', '/%61pi', '/elsewhere'])
      assert.equal(isLegacyPath(path), false)
  })
  it('fails closed on malformed, oversized, redirected and inconsistent gates', async () => {
    const responses = [
      new Response('<html>not JSON</html>'),
      new Response('bad json', { headers: { 'Content-Type': 'application/json' } }),
      new Response(JSON.stringify({ access: 'allowed', extra: 'x'.repeat(1500) }), {
        headers: { 'Content-Type': 'application/json' },
      }),
      gate('allowed', 403),
      gate('unknown', 200),
      new Response(null, { status: 302, headers: { Location: '/auth/sign-in' } }),
    ]
    for (const gateResponse of responses) {
      let rendered = false
      const response = await createPreviewGateway({
        backend: async () => gateResponse,
        application: () => {
          rendered = true
          return app()
        },
      })(request())
      assert.equal(response.status, 503)
      assert.equal(rendered, false)
      noStore(response)
    }
  })
  it('bounds a stalled gate and aborts the request', async () => {
    let signal: AbortSignal | undefined
    const response = await createPreviewGateway({
      gateTimeoutMs: 10,
      backend: (input) => {
        signal = input.signal
        return new Promise(() => {})
      },
      application: app,
    })(request())
    assert.equal(response.status, 503)
    assert.equal(signal?.aborted, true)
  })
  it('bounds and cancels a stalled gate response body', async () => {
    let cancelled = false
    const source = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    const response = await createPreviewGateway({
      gateTimeoutMs: 10,
      backend: async () =>
        new Response(source, { headers: { 'Content-Type': 'application/json' } }),
      application: app,
    })(request())
    assert.equal(response.status, 503)
    assert.equal(cancelled, true)
  })
  it('fails closed on backend and rendering failures without echoing secrets', async () => {
    for (const failBackend of [true, false]) {
      const response = await createPreviewGateway({
        backend: async () => {
          if (failBackend) throw new Error('private detail')
          return gate('allowed')
        },
        application: () => {
          throw new Error('private detail')
        },
      })(request())
      assert.equal(response.status, 503)
      assert.equal((await response.text()).includes('private detail'), false)
    }
  })
  it('gates HEAD but returns no body', async () => {
    let checked = false
    const response = await createPreviewGateway({
      backend: async () => {
        checked = true
        return gate('allowed')
      },
      application: app,
    })(request('/', { method: 'HEAD' }))
    assert.equal(checked, true)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '')
    noStore(response)
  })
  it('rejects root mutations before consulting either application', async () => {
    const response = await createPreviewGateway({
      backend: async () => {
        throw new Error('unexpected')
      },
      application: () => {
        throw new Error('unexpected')
      },
    })(request('/', { method: 'POST' }))
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  })
  it('rejects WebSocket upgrades explicitly in this HTTP-only preview', async () => {
    assert.equal(
      (
        await createPreviewGateway({ application: app })(
          request('/api/events', { headers: { Upgrade: 'websocket' } })
        )
      ).status,
      426
    )
  })
  it('serves hashed Start assets but never treats unknown routes as a workspace', async () => {
    const handler = createPreviewGateway({
      application: () => {
        throw new Error('must not render')
      },
      assets: async (input) =>
        input.url.includes('/start-assets/')
          ? new Response('js')
          : new Response(null, { status: 404 }),
    })
    const asset = await handler(request('/start-assets/chunk-abc.js'))
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(await asset.text(), 'js')
    assert.equal((await handler(request('/unknown'))).status, 404)
    assert.equal((await handler(request('/_serverFn/missing'))).status, 404)
  })
  it('ignores a client-provided upstream URL', async () => {
    const response = await createPreviewGateway({
      backend: async (input) => {
        assert.equal(new URL(input.url).origin, origin)
        return new Response('known backend')
      },
      application: app,
    })(request('/api/plugins?url=https://attacker.test'))
    assert.equal(await response.text(), 'known backend')
  })
})

describe('workspace query semantics', () => {
  it('keeps string zero, blank flags and repeated values', () => {
    const input = parseWorkspaceSearch(
      '?roomDesigner=0&characterDesigner=&scene=home&scene=work&other=x'
    )
    assert.equal(input.roomDesigner, '0')
    assert.deepEqual(input.scene, ['home', 'work'])
    const result = workspaceSelection(input)
    assert.equal(result.roomDesigner, false)
    assert.equal(result.characterDesigner, true)
    assert.equal(result.virtual, false)
  })
  it('round-trips unfamiliar parameters and encoded special characters', () => {
    const query = '?scene=home&x=a%26b&x=c%2Bd&empty=&unicode=%F0%9F%92%9C'
    const parsed = parseWorkspaceSearch(query)
    assert.deepEqual(parseWorkspaceSearch(stringifyWorkspaceSearch(parsed)), parsed)
  })
  it('rejects prototype keys and nonprimitive serialized values', () => {
    const parsed = parseWorkspaceSearch('?__proto__=bad&constructor=bad&prototype=bad&scene=work')
    assert.equal(Object.getPrototypeOf(parsed), null)
    assert.deepEqual(Object.keys(parsed), ['scene'])
    assert.throws(() => stringifyWorkspaceSearch({ value: { nested: 'bad' } }))
  })
  it('matches the original room and character designer flag rules', () => {
    for (const value of ['', '1', 'true', 'false']) {
      const selected = workspaceSelection({ roomDesigner: value, characterDesigner: value })
      assert.equal(selected.roomDesigner, true)
      assert.equal(selected.characterDesigner, true)
      assert.equal(selected.virtual, true)
    }
    assert.equal(workspaceSelection({ roomDesigner: ['0', '1'] }).virtual, false)
    assert.equal(workspaceSelection({ view: 'virtual' }).virtual, true)
  })
  it('accepts only the existing camera modes and the first character value', () => {
    assert.equal(workspaceSelection({ camera: 'invalid' }).cameraViewMode, undefined)
    assert.equal(
      workspaceSelection({ camera: ['orthographic', 'bad'] }).cameraViewMode,
      'orthographic'
    )
    assert.equal(workspaceSelection({ character: ['first', 'second'] }).character, 'first')
  })
})

describe('browser dependency guard', () => {
  it('blocks actual Next runtime, DB modules, auth-server code and gateway code', () => {
    // Negative module IDs are fixture data, not application provider imports.
    for (const id of forbiddenModuleFixtures) assert.equal(forbiddenClientModule(id), true, id)
  })
  it('allows the specific preview bridge and client-only shared packages', () => {
    for (const id of [
      '/repo/apps/web/src/start-preview/lazy-component.tsx',
      '/repo/packages/auth/dist/client.js',
      '/repo/packages/workspace-ui/dist/index.js',
      '/repo/node_modules/react/index.js',
    ])
      assert.equal(forbiddenClientModule(id), false, id)
  })
  it('has no private environment name in the public substitution allowlist', () => {
    assert.equal(
      PUBLIC_ENV_NAMES.some((name) => PRIVATE_ENV_NAMES.includes(name)),
      false
    )
    assert.equal(
      PUBLIC_ENV_NAMES.every((name) => name.startsWith('NEXT_PUBLIC_')),
      true
    )
  })
})

describe('preview component boundary', () => {
  it('never loads browser components while rendering the server fallback', () => {
    let imports = 0
    const Deferred = lazyComponent(
      async () => {
        imports++
        return () => null
      },
      { ssr: false, loading: () => 'Opening workspace' }
    )
    assert.match(renderToString(createElement(Deferred, {})), /Opening workspace/)
    assert.equal(imports, 0)
  })
})
