// The shell's loopback server helpers: the same-origin cloud proxy and the
// optional Agent Sim engine mount. These run in Bun's test runner inside the
// desktop lane they serve.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentSimResponse } from '../shell/src/agent-sim-assets'
import { cloudProxyRequest, proxyCloudRequest, resolveCloudOrigin } from '../shell/src/cloud-proxy'

describe('cloud proxy', () => {
  const CLOUD = 'https://adea.dev'
  const SHELL = 'http://127.0.0.1:4789'

  test('states the trusted shell origin and drops hop-by-hop headers', () => {
    const incoming = new Headers({
      authorization: 'Desktop cred-123',
      'x-adea-client': 'desktop',
      origin: SHELL,
      referer: `${SHELL}/workspace`,
      host: '127.0.0.1:4789',
      cookie: 'ambient=1',
    })
    const { target, headers } = cloudProxyRequest(
      new URL(`${SHELL}/api/marketplace/catalog?workspaceId=w1`),
      incoming,
      CLOUD,
      SHELL
    )
    expect(target).toBe(`${CLOUD}/api/marketplace/catalog?workspaceId=w1`)
    expect(headers.get('authorization')).toBe('Desktop cred-123')
    expect(headers.get('x-adea-client')).toBe('desktop')
    // Same-origin GETs carry no Origin header; the proxy states the shell
    // origin the cloud's desktop lane trusts.
    expect(headers.get('origin')).toBe(SHELL)
    expect(headers.has('referer')).toBe(false)
    expect(headers.has('host')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
  })

  test('resolves the cloud origin from the environment and refuses bogus values', () => {
    expect(resolveCloudOrigin({})).toBe('https://adea.dev')
    expect(resolveCloudOrigin({ ADEA_CLOUD_ORIGIN: 'http://127.0.0.1:3210' })).toBe(
      'http://127.0.0.1:3210'
    )
    expect(() => resolveCloudOrigin({ ADEA_CLOUD_ORIGIN: 'https://adea.dev/api' })).toThrow()
    expect(() => resolveCloudOrigin({ ADEA_CLOUD_ORIGIN: 'http://evil.example' })).toThrow()
  })

  test('forwards status, body, and headers while dropping set-cookie', async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' },
        })) as typeof fetch
      const request = new Request(`${SHELL}/api/v1/workspaces/w1/tasks`, {
        method: 'POST',
        headers: { authorization: 'Temporary tmp-1' },
        body: '{"workspaceId":"w1"}',
      })
      const response = await proxyCloudRequest(request, CLOUD, SHELL)
      expect(response.status).toBe(201)
      expect(await response.json()).toEqual({ ok: true })
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(response.headers.has('set-cookie')).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })

  test('answers a dead cloud with a clean 502 instead of hanging', async () => {
    const original = globalThis.fetch
    try {
      globalThis.fetch = (async () => {
        throw new Error('connection refused')
      }) as typeof fetch
      const response = await proxyCloudRequest(
        new Request(`${SHELL}/api/v1/workspaces/w1`),
        CLOUD,
        SHELL
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        code: 'cloud_unreachable',
        message: expect.any(String),
      })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('agent sim mount', () => {
  const packRoot = mkdtempSync(join(tmpdir(), 'adea-agent-sim-'))

  beforeAll(() => {
    mkdirSync(join(packRoot, 'models'), { recursive: true })
    writeFileSync(join(packRoot, 'engine.json'), JSON.stringify({ version: '0.11.0' }))
    writeFileSync(join(packRoot, 'engine.js'), 'export const mount = () => ({})\n')
    writeFileSync(join(packRoot, 'models', 'scene.glb'), new Uint8Array([1, 2, 3]))
  })

  afterAll(() => {
    rmSync(packRoot, { force: true, recursive: true })
  })

  test('wraps the raw export manifest into the gate shape', async () => {
    const response = await agentSimResponse('/assets/agent-sim/engine.json', packRoot)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      engine: { entryUrl: '/assets/agent-sim/engine.js', version: '0.11.0' },
    })
  })

  test('passes the wrapped pack-lane manifest through unchanged in shape', async () => {
    const wrappedRoot = mkdtempSync(join(tmpdir(), 'adea-agent-sim-'))
    try {
      writeFileSync(
        join(wrappedRoot, 'engine.json'),
        JSON.stringify({ engine: { entryUrl: '/assets/agent-sim/engine.js', version: '1.2.3' } })
      )
      const response = await agentSimResponse('/assets/agent-sim/engine.json', wrappedRoot)
      expect(await response.json()).toEqual({
        engine: { entryUrl: '/assets/agent-sim/engine.js', version: '1.2.3' },
      })
    } finally {
      rmSync(wrappedRoot, { force: true, recursive: true })
    }
  })

  test('serves engine files with their types and keeps traversal inside the pack', async () => {
    const entry = await agentSimResponse('/assets/agent-sim/engine.js', packRoot)
    expect(entry.status).toBe(200)
    expect(entry.headers.get('content-type')).toBe('text/javascript')
    const model = await agentSimResponse('/assets/agent-sim/models/scene.glb', packRoot)
    expect(model.headers.get('content-type')).toBe('model/gltf-binary')
    // `..` segments normalize to a path inside the pack root, never above it.
    const dotdot = await agentSimResponse('/assets/agent-sim/../engine.js', packRoot)
    expect(dotdot.status).toBe(200)
    const missing = await agentSimResponse('/assets/agent-sim/models/nope.glb', packRoot)
    expect(missing.status).toBe(404)
  })

  test('answers a pack without a usable manifest with a 404 the gate reads as unavailable', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'adea-agent-sim-'))
    try {
      const response = await agentSimResponse('/assets/agent-sim/engine.json', emptyRoot)
      expect(response.status).toBe(404)
    } finally {
      rmSync(emptyRoot, { force: true, recursive: true })
    }
  })
})
