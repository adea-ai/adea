import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, it } from 'bun:test'
import assert from 'node:assert/strict'
import lazyComponent from '../src/components/lazy-component'
import forbiddenModuleFixtures from './start-client-denylist.json'
import { evaluateEntryAccess } from '../src/lib/entry-access-policy.mjs'
import { failure, finalizeDynamicResponse, rootDocumentPolicy } from '../src/start/http-policy.mjs'
import { parseWorkspaceSearch, stringifyWorkspaceSearch } from '../src/start/search-codec.mjs'
import { workspaceSelection } from '../src/start/workspace-selection.mjs'
import {
  forbiddenClientModule,
  PUBLIC_ENV_NAMES,
  PRIVATE_ENV_NAMES,
} from '../start/client-policy.mjs'

const origin = 'https://adea-start.test'
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
describe('dynamic response policy', () => {
  it('marks every dynamic response private and unindexed', async () => {
    for (const response of [
      await finalizeDynamicResponse(
        new Response('ok', { headers: { 'Content-Type': 'text/plain' } }),
        request()
      ),
      await finalizeDynamicResponse(
        Response.json({ access: 'allowed' }),
        request('/api/web-entry')
      ),
      await finalizeDynamicResponse(
        new Response('<!doctype html><html>workspace</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
        request('/')
      ),
    ]) {
      noStore(response)
    }
  })
  it('preserves status, status text and body while adding the policy headers', async () => {
    const response = await finalizeDynamicResponse(
      Response.json({ code: 'workspace_unavailable' }, { status: 401, statusText: 'Unauthorized' }),
      request('/api/workspaces/bootstrap', { method: 'POST' })
    )
    assert.equal(response.status, 401)
    assert.equal(response.statusText, 'Unauthorized')
    assert.deepEqual(await response.json(), { code: 'workspace_unavailable' })
  })
  it('does not buffer a streaming body', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first'))
        controller.close()
      },
    })
    const response = await finalizeDynamicResponse(new Response(stream), request('/api/events'))
    assert.equal(await response.text(), 'first')
  })
  it('rejects root mutations with the migration-era 405 contract', () => {
    const rejected = rootDocumentPolicy(request('/', { method: 'POST' }))
    assert.ok(rejected)
    assert.equal(rejected.status, 405)
    assert.equal(rejected.headers.get('allow'), 'GET, HEAD')
    noStore(rejected)
    assert.equal(rootDocumentPolicy(request('/', { method: 'GET' })), null)
    assert.equal(rootDocumentPolicy(request('/', { method: 'HEAD' })), null)
    assert.equal(rootDocumentPolicy(request('/other', { method: 'POST' })), null)
  })
  it('returns no body for HEAD while keeping the status and headers', async () => {
    const response = await finalizeDynamicResponse(
      new Response('body', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      request('/', { method: 'HEAD' })
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '')
    noStore(response)
  })
  it('never echoes request details in a failure body', () => {
    const response = failure(503, 'Workspace entry is temporarily unavailable')
    assert.equal(response.status, 503)
    noStore(response)
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
  it('allows the specific workspace bridge and client-only shared packages', () => {
    for (const id of [
      '/repo/apps/web/src/components/lazy-component.tsx',
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

describe('lazy component boundary', () => {
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
