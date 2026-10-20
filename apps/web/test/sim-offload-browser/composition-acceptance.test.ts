import { expect, test } from 'bun:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import solid from 'vite-plugin-solid'
import { fileURLToPath } from 'node:url'
import type { LaunchCodeBinding } from '@adea-ai/spatial/sim-bridge'

import { createSimApi } from '../../src/server/sim-http'
import { createSimLaunchService } from '../../src/server/sim-launch-service'
import { createSimHostService } from '../../src/server/sim-host-service'
import { createSimPrivateAssetReader } from '../../src/server/sim-private-assets'

// The qualified authorized service: the approved composition on both sides of the launch, driven
// against disposable in-memory stores. It proves the composition itself, not only the pieces it
// is built from: an entitled workspace gets a frame and its private entry, an unentitled workspace
// gets nothing, and the optional view never takes the rest of the app down with it.
type Row = {
  code: string
  workspaceId: string
  binding: LaunchCodeBinding
  expiresAt: number
  spent: boolean
}

type StoredSession = {
  workspaceId: string
  surface: 'hq' | 'room-designer' | 'character-designer'
  expiresAt: number
}

function memoryStore(sessions: Map<string, StoredSession>) {
  const rows = new Map<string, Row>()
  const store = {
    rows,
    issue(code: string, binding: LaunchCodeBinding, workspaceId: string, expiresAt: number) {
      rows.set(code, { code, workspaceId, binding, expiresAt, spent: false })
    },
    redeem(code: string, presented: { bridgeId: string; origin: string }, now: number) {
      const row = rows.get(code)
      if (!row) return { ok: false as const, reason: 'unknown' as const }
      if (row.spent) return { ok: false as const, reason: 'code_used' as const }
      row.spent = true
      if (row.expiresAt <= now) return { ok: false as const, reason: 'code_expired' as const }
      if (row.binding.bridgeId !== presented.bridgeId || row.binding.origin !== presented.origin)
        return { ok: false as const, reason: 'origin_refused' as const }
      return { ok: true as const, surface: row.binding.surface }
    },
    redeemAndSave(
      code: string,
      presented: { bridgeId: string; origin: string },
      now: number,
      session: { value: string; expiresAt: number }
    ) {
      const result = store.redeem(code, presented, now)
      if (result.ok) {
        const row = rows.get(code)!
        sessions.set(session.value, {
          workspaceId: row.workspaceId,
          surface: row.binding.surface,
          expiresAt: session.expiresAt,
        })
      }
      return result
    },
  }
  return store
}

test('the qualified service serves the optional view and leaves the app usable when it does not', async () => {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../../src/lib/sim-host-entry.ts', import.meta.url))],
    target: 'browser',
  })
  expect(built.success).toBe(true)
  const frameScript = await built.outputs[0]!.text()

  const sessions = new Map<string, StoredSession>()
  const store = memoryStore(sessions)
  const entitled = new Set(['workspace-one'])
  const policy = (scope: { workspaceId: string }) =>
    entitled.has(scope.workspaceId) ? 'entitled' : 'not_entitled'

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
            const chunks: Buffer[] = []
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
            const url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}${incoming.url}`
            const request = new Request(url, {
              method: incoming.method,
              headers: incoming.headers as Record<string, string>,
              ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
            })
            const response = incoming.url.endsWith('/config')
              ? api?.configuration()
              : await api?.launch(request)
            if (!response) {
              outgoing.statusCode = 503
              outgoing.end()
              return
            }
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

  const reader = createSimPrivateAssetReader({
    location: 'agent-sim-export',
    read: async ({ key }) => {
      if (key === 'engine.json') {
        return {
          body: JSON.stringify({ version: 'composition-fixture' }),
          contentType: 'application/json',
        }
      }
      if (['engine.js', 'room-designer.js', 'character-designer.js'].includes(key)) {
        return {
          body: `const runtime={async mount({container,scene}){const node=document.createElement('canvas');node.dataset.testSimScene=scene;container.append(node);return{unmount(){node.remove()}}}};window.__adeaAgentSim=runtime;window.adeaAgentSimSurfaces={'room-designer':runtime,'character-designer':runtime}`,
          contentType: 'text/javascript',
        }
      }
      return null
    },
  })

  let serve: ((request: Request) => Promise<Response>) | undefined
  const simServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => serve?.(request) ?? new Response(null, { status: 503 }),
  })
  const origin = simServer.url.origin

  const launch = createSimLaunchService({
    frameOrigin: origin,
    allowLoopbackHttp: true,
    createStore: (workspaceId) => ({
      issue: (code: string, binding: LaunchCodeBinding, expiresAt: number) =>
        store.issue(code, binding, workspaceId, expiresAt),
      redeem: store.redeem,
      redeemAndSave: store.redeemAndSave,
    }),
    ports: {
      resolvePrincipal: (request) =>
        request.headers.get('authorization') ? { userId: 'local-user' } : null,
      authorizeWorkspace: (_principal, _action, workspaceId) => entitled.has(workspaceId),
      policy,
    },
  })

  api = createSimApi({
    frameOrigin: origin,
    allowLoopbackHttp: true,
    trustedHostOrigins: [parentOrigin],
    issue: async (request, body) => launch(request, body),
  })

  serve = createSimHostService({
    configuration: {
      origin,
      parentOrigins: [parentOrigin],
      allowLoopbackHttp: true,
      assetPrefix: '/assets/agent-sim/',
      entryFiles: {
        hq: 'engine.js',
        'room-designer': 'room-designer.js',
        'character-designer': 'character-designer.js',
      },
    },
    store: {
      issue: () => {
        throw new Error('the hosted service never issues codes')
      },
      redeem: store.redeem,
      redeemAndSave: store.redeemAndSave,
    },
    sessions: async (value) => sessions.get(value) ?? null,
    policy,
    readAsset: (path) => reader(path),
    frameScript,
  })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    // The private export is not reachable without a session, and it has no public alias.
    expect((await fetch(`${origin}/assets/agent-sim/engine.js`)).status).toBe(401)
    expect((await fetch(`${origin}/private/agent-sim/engine.js`)).status).toBe(404)

    // The entitled workspace gets the optional view and its private entry.
    await page.goto(parentOrigin)
    await page.locator('iframe[data-agent-sim-active="true"]').waitFor({ timeout: 20_000 })
    await page.frameLocator('iframe').locator('canvas').first().waitFor({ timeout: 20_000 })
    expect(
      await page.frameLocator('iframe').locator('canvas').getAttribute('data-test-sim-scene')
    ).toBe('work')
    expect(store.rows.size).toBe(1)

    // The session cookie is the only carrier, and it is a sim-only cookie.
    const cookies = await context.cookies()
    const session = cookies.find((cookie) => cookie.name === '__Host-adea-sim')
    expect(session?.httpOnly).toBe(true)
    expect(session?.secure).toBe(true)
    expect(session?.sameSite).toBe('None')

    // An unentitled workspace is refused, and the rest of the app stays reachable.
    await page.goto(`${parentOrigin}/?workspace=workspace-two`)
    await page.getByText('Agent Sim is not included in this account').waitFor({ timeout: 20_000 })
    expect(await page.locator('iframe').count()).toBe(0)
    expect(store.rows.size).toBe(1)
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    expect(await page.getByText('Chat stays available').isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Dev', exact: true }).click()
    expect(await page.getByText('Dev stays available').isVisible()).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await hostServer.close()
    simServer.stop(true)
  }
}, 120_000)
