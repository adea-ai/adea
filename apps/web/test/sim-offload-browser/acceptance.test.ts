import { expect, test } from 'bun:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import solid from 'vite-plugin-solid'
import { fileURLToPath } from 'node:url'
import { realpath, stat } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import {
  createLaunchCodeLedger,
  createSimLaunchIssuer,
  createSimSessionExchange,
  type SimSessionRecord,
} from '../../../../packages/spatial/src/sim-bridge'
import { createSimApi } from '../../src/server/sim-http'
import { createSimHost } from '../../src/server/sim-host'

// Real network and browser; only entitlement, storage and the tiny engine fixture are disposable.
// Set ADEA_SIM_TEST_EXPORT to an existing private export to additionally mount that export locally.
test('app -> launch -> cross-origin frame -> session -> private runtime; offline Sim leaves Chat and Dev independent', async () => {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../../src/lib/sim-host-entry.ts', import.meta.url))],
    target: 'browser',
  })
  expect(built.success).toBe(true)
  const frameScript = await built.outputs[0]!.text()
  let api: ReturnType<typeof createSimApi> | undefined
  const hostServer = await createServer({
    configFile: false,
    clearScreen: false,
    logLevel: 'error',
    root: fileURLToPath(new URL('../fixtures/sim-offload/', import.meta.url)),
    plugins: [
      solid(),
      {
        name: 'local-sim-api-fixture',
        configureServer(server) {
          server.middlewares.use(async (incoming, outgoing, next) => {
            if (!incoming.url?.startsWith('/api/sim/')) {
              next()
              return
            }
            if (!api) {
              outgoing.statusCode = 503
              outgoing.end()
              return
            }
            expect(incoming.headers.cookie ?? '').not.toContain('__Host-adea-sim=')
            const chunks: Buffer[] = []
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
            const url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}${incoming.url}`
            const request = new Request(url, {
              method: incoming.method,
              headers: incoming.headers as Record<string, string>,
              ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
            })
            const response = incoming.url.endsWith('/config')
              ? api.configuration()
              : await api.launch(request)
            outgoing.statusCode = response.status
            response.headers.forEach((value, key) => outgoing.setHeader(key, value))
            outgoing.end(await response.text())
          })
        },
      },
    ],
    resolve: { dedupe: ['solid-js'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, fs: { strict: false } },
  })
  await hostServer.listen()
  const parentOrigin = `http://localhost:${(hostServer.httpServer!.address() as { port: number }).port}`
  let serve: ((request: Request) => Promise<Response>) | undefined
  const simServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => serve?.(request) ?? new Response(null, { status: 503 }),
  })
  const origin = simServer.url.origin
  const store = createLaunchCodeLedger()
  const sessions = new Map<string, SimSessionRecord>()
  let grants = 0
  let assetReads = 0
  const privateRoot = process.env.ADEA_SIM_TEST_EXPORT
    ? await realpath(process.env.ADEA_SIM_TEST_EXPORT)
    : null
  const issuer = createSimLaunchIssuer({
    frameOrigin: origin,
    allowLoopbackHttp: true,
    store,
    entitlement: async (query) =>
      query.workspaceId === 'workspace-one' ? 'entitled' : 'not_entitled',
  })
  const exchange = createSimSessionExchange({
    origin,
    allowLoopbackHttp: true,
    store,
    sessions: {
      save(value, record) {
        sessions.set(value, record)
      },
    },
  })
  api = createSimApi({
    frameOrigin: origin,
    allowLoopbackHttp: true,
    trustedHostOrigins: [parentOrigin],
    issue: async (request, body) => {
      if (request.headers.get('authorization') !== 'Temporary local-acceptance-fixture')
        return { status: 'denied', reason: 'unauthenticated' }
      grants++
      return issuer(body)
    },
  })
  serve = createSimHost({
    origin,
    parentOrigins: [parentOrigin],
    allowLoopbackHttp: true,
    assetPrefix: '/assets/agent-sim/',
    entryFiles: {
      hq: 'engine.js',
      'room-designer': 'room-designer.js',
      'character-designer': 'character-designer.js',
    },
    frameScript,
    exchange,
    session: async (value) => sessions.get(value) ?? null,
    readAsset: async (path) => {
      assetReads++
      if (privateRoot) {
        const file = await realpath(resolve(privateRoot, path)).catch(() => null)
        if (!file || !file.startsWith(privateRoot + sep) || !(await stat(file)).isFile())
          return null
        const mime: Record<string, string> = {
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.glb': 'model/gltf-binary',
          '.wasm': 'application/wasm',
          '.webp': 'image/webp',
          '.png': 'image/png',
        }
        return {
          body: Bun.file(file),
          contentType: mime[extname(file)] ?? 'application/octet-stream',
        }
      }
      if (path === 'engine.json')
        return {
          body: JSON.stringify({
            version: 'local-fixture',
            surfaces: {
              'room-designer': 'room-designer.js',
              'character-designer': 'character-designer.js',
            },
          }),
          contentType: 'application/json',
        }
      if (['engine.js', 'room-designer.js', 'character-designer.js'].includes(path))
        return {
          body: `const runtime={async mount({container,scene}){const node=document.createElement('canvas');node.dataset.testSimScene=scene;container.append(node);return{unmount(){node.remove()}}}};window.__adeaAgentSim=runtime;window.adeaAgentSimSurfaces={'room-designer':runtime,'character-designer':runtime}`,
          contentType: 'text/javascript',
        }
      return null
    },
  })
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    expect((await fetch(`${origin}/assets/agent-sim/engine.js`)).status).toBe(401)
    expect(assetReads).toBe(0)
    await page.goto(parentOrigin)
    await page
      .locator('iframe[data-agent-sim-active="true"]')
      .waitFor({ timeout: privateRoot ? 60_000 : 20_000 })
    expect(grants).toBe(1)
    expect(assetReads).toBeGreaterThanOrEqual(2)
    if (!privateRoot)
      expect(
        await page.frameLocator('iframe').locator('canvas').getAttribute('data-test-sim-scene')
      ).toBe('work')
    else {
      await page.frameLocator('iframe').locator('canvas').first().waitFor({ timeout: 60_000 })
      if (process.env.ADEA_SIM_SCREENSHOT)
        await page.screenshot({ path: process.env.ADEA_SIM_SCREENSHOT })
    }
    await page.waitForLoadState('networkidle')
    for (const [value, record] of sessions)
      sessions.set(value, { ...record, expiresAt: Date.now() - 1 })
    const readsBeforeExpiry = assetReads
    const expiredStatus = await page
      .frameLocator('iframe')
      .locator('body')
      .evaluate(async () => {
        return (
          await fetch('/assets/agent-sim/engine.json', {
            credentials: 'same-origin',
            cache: 'no-store',
          })
        ).status
      })
    expect(expiredStatus).toBe(401)
    expect(assetReads).toBe(readsBeforeExpiry)
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByRole('button', { name: 'Sim', exact: true }).click()
    await page.locator('iframe[data-agent-sim-active="true"]').waitFor({ timeout: 20_000 })
    expect(grants).toBe(2)
    for (const surface of ['room-designer', 'character-designer']) {
      await page.goto(`${parentOrigin}/?surface=${surface}`)
      await page
        .locator('iframe[data-agent-sim-active="true"]')
        .waitFor({ timeout: privateRoot ? 60_000 : 20_000 })
      await page.frameLocator('iframe').locator('canvas').first().waitFor({ timeout: 60_000 })
    }
    expect(grants).toBe(4)
    const cookies = await context.cookies()
    console.log(
      'cookie attributes',
      cookies.map(({ name, secure, httpOnly, sameSite, partitionKey }) => ({
        name,
        secure,
        httpOnly,
        sameSite,
        partitionKey,
      }))
    )
    const session = cookies.find((cookie) => cookie.name === '__Host-adea-sim')
    expect(session?.httpOnly).toBe(true)
    expect(session?.secure).toBe(true)
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    expect(await page.getByText('Chat stays available').isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Dev', exact: true }).click()
    expect(await page.getByText('Dev stays available').isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Sim', exact: true }).click()
    await page.getByText('Agent Sim is offline', { exact: true }).waitFor()
    expect(grants).toBe(4)
    await context.setOffline(false)
    await page.getByRole('button', { name: 'Sim', exact: true }).click()
    await page.locator('iframe[data-agent-sim-active="true"]').waitFor({ timeout: 20_000 })
    expect(grants).toBe(5)
    expect(errors).toEqual([])
    console.log(
      JSON.stringify({
        evidence: 'local-only',
        privateExport: Boolean(privateRoot),
        grants,
        assetReads,
        httpOnlySession: true,
        chatDevWhileOffline: true,
        expiredSessionRefused: true,
        freshLaunchAfterExpiry: true,
      })
    )
  } finally {
    await browser.close()
    await hostServer.close()
    simServer.stop(true)
  }
}, 120_000)
