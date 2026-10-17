// The shell's loopback server helpers: the same-origin cloud proxy and the
// retired Agent Sim engine mount. These run in Bun's test runner inside the
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

  test('resolves the cloud origin from the persisted build target and refuses bogus values', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-target-'))
    try {
      writeFileSync(
        join(root, 'adea-desktop-target.json'),
        '{"mode":"release","cloudOrigin":"https://adea.dev"}'
      )
      expect(resolveCloudOrigin(root, {})).toBe('https://adea.dev')
      expect(() =>
        resolveCloudOrigin(root, { ADEA_CLOUD_ORIGIN: 'https://adea.dev/api' })
      ).toThrow()
      expect(() => resolveCloudOrigin(root, { ADEA_CLOUD_ORIGIN: 'http://evil.example' })).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  test('refuses a present legacy pack without serving any private bytes', async () => {
    for (const path of ['engine.json', 'engine.js', 'models/scene.glb', '../engine.js']) {
      const response = await agentSimResponse(`/assets/agent-sim/${path}`, packRoot)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  test('refuses an absent pack with the same response', async () => {
    expect((await agentSimResponse('/assets/agent-sim/engine.json', '/never-read')).status).toBe(
      404
    )
  })
})
