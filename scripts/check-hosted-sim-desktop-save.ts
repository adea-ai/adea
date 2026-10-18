// Actual built desktop UI and private engine; disposable local authority/storage only.
import { chromium, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import {
  createLaunchCodeLedger,
  createSimLaunchIssuer,
  createSimSessionExchange,
  type SimSessionRecord,
} from '../packages/spatial/src/sim-bridge'
import { createSimApi } from '../apps/web/src/server/sim-http'
import { createSimHost } from '../apps/web/src/server/sim-host'
import { serveDesktopClient } from '../apps/desktop/shell/src/client-assets'

const client = fileURLToPath(new URL('../apps/web/dist-desktop/client/', import.meta.url))
if (!process.env.ADEA_SIM_TEST_EXPORT)
  throw new Error('ADEA_SIM_TEST_EXPORT must name a private local export')
const privateRoot = await realpath(process.env.ADEA_SIM_TEST_EXPORT)
const frameBuild = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../apps/web/src/lib/sim-host-entry.ts', import.meta.url))],
  target: 'browser',
})
if (!frameBuild.success) throw new Error('Frame build failed')
let simFetch: ((request: Request) => Promise<Response>) | undefined
const simServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => simFetch?.(request) ?? new Response(null, { status: 503 }),
})
let api: ReturnType<typeof createSimApi> | undefined
const workspace = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Local Sim qualification',
  scene: 'home',
  accent: null,
  logo: { kind: 'monogram' },
  sortOrder: 0,
  version: 1,
  updatedAt: '2026-10-17T00:00:00Z',
}
const credential = `adea_tmp_${'c'.repeat(43)}`
let grants = 0
const requests: string[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push(path)
    expect(request.headers.get('cookie') ?? '').not.toContain('__Host-adea-sim=')
    if (path === '/api/workspaces/bootstrap')
      return Response.json({
        activeWorkspace: workspace,
        principal: { temporary: true, userId: '00000000-0000-4000-8000-000000000001' },
        temporaryCredential: credential,
        workspaces: [workspace],
      })
    if (path === '/api/workspaces') return Response.json([workspace])
    if (path === '/api/sim/config') return api!.configuration()
    if (path === '/api/sim/launch') {
      grants++
      return api!.launch(request)
    }
    if (path === '/api/v1/account/summary') return Response.json({ workspaces: [] })
    if (path.startsWith('/api/v1/account/agents')) return Response.json({ agents: [] })
    if (path.startsWith('/api/v1/account/conversations'))
      return Response.json({ conversations: [] })
    if (path.endsWith('/events'))
      return new Response('', { headers: { 'content-type': 'text/event-stream' } })
    if (path.startsWith('/api/')) {
      if (path.endsWith('/read-state')) return Response.json({ readState: [] })
      if (
        ['/projects', '/agents', '/tasks', '/channels', '/artifacts'].some((suffix) =>
          path.endsWith(suffix)
        )
      )
        return Response.json([])
      return Response.json({})
    }
    return serveDesktopClient(request, client)
  },
})
const origin = `http://localhost:${server.port}`
const ledger = createLaunchCodeLedger()
const sessions = new Map<string, SimSessionRecord>()
const launches: { surface: string; character?: string }[] = []
const issue = createSimLaunchIssuer({
  frameOrigin: simServer.url.origin,
  allowLoopbackHttp: true,
  store: ledger,
  entitlement: async (query) => (query.workspaceId === workspace.id ? 'entitled' : 'not_entitled'),
})
api = createSimApi({
  frameOrigin: simServer.url.origin,
  allowLoopbackHttp: true,
  trustedHostOrigins: [origin],
  issue: async (request, body) => {
    if (request.headers.get('authorization') !== `Temporary ${credential}`)
      return { status: 'denied', reason: 'unauthenticated' }
    return issue(body)
  },
})
const exchange = createSimSessionExchange({
  origin: simServer.url.origin,
  allowLoopbackHttp: true,
  store: ledger,
  sessions: {
    save(value, record) {
      sessions.set(value, record)
    },
  },
})
let assetReads = 0
simFetch = createSimHost({
  origin: simServer.url.origin,
  parentOrigins: [origin],
  allowLoopbackHttp: true,
  frameScript: await frameBuild.outputs[0]!.text(),
  exchange,
  session: async (value) => sessions.get(value) ?? null,
  readAsset: async (path) => {
    const file = await realpath(resolve(privateRoot, path)).catch(() => null)
    if (!file || !file.startsWith(privateRoot + sep) || !(await stat(file)).isFile()) return null
    assetReads++
    const mime: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.glb': 'model/gltf-binary',
      '.wasm': 'application/wasm',
      '.webp': 'image/webp',
      '.png': 'image/png',
    }
    return { body: Bun.file(file), contentType: mime[extname(file)] ?? 'application/octet-stream' }
  },
})
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.route('**/*', (route) =>
  [origin, simServer.url.origin].includes(new URL(route.request().url()).origin)
    ? route.continue()
    : route.abort()
)
await context.addInitScript(() => {
  const win = window as unknown as { __adeaDesktop: unknown }
  win.__adeaDesktop = {
    invoke: async (command: string) => {
      if (command === 'adea_app_version') return 'local-fixture'
      if (
        command === 'desktop_user_session_load' ||
        command === 'desktop_auth_take_callback' ||
        command === 'desktop_temporary_workspace_load' ||
        command === 'desktop_temporary_workspace_save' ||
        command === 'local_content_authorize_workspace'
      )
        return null
      throw new Error('Local fixture supplies no native authority')
    },
    listen: async () => () => {},
  }
})
const page = await context.newPage()
await context.addInitScript(() => {
  const delayed = new WeakSet<object>()
  if (window.parent === window)
    window.addEventListener(
      'message',
      (event) => {
        const win = window as unknown as { delaySimSave?: boolean; releaseSimSave?: () => void }
        if (
          !win.delaySimSave ||
          event.data?.type !== 'frame.character.save' ||
          delayed.has(event.data)
        )
          return
        delayed.add(event.data)
        win.delaySimSave = false
        event.stopImmediatePropagation()
        const { data, origin: sourceOrigin, source } = event
        win.releaseSimSave = () => {
          window.dispatchEvent(new MessageEvent('message', { data, origin: sourceOrigin, source }))
          delete win.releaseSimSave
        }
      },
      { capture: true }
    )
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'host.launch') {
      const win = window as unknown as { testLaunches?: unknown[] }
      ;(win.testLaunches ??= []).push(event.data.payload)
    }
  })
  const trace: string[] = []
  const iframeTrace: unknown[] = []
  ;(window as unknown as { simIframeTrace: unknown[] }).simIframeTrace = iframeTrace
  if (window.parent === window) {
    const ids = new WeakMap<HTMLIFrameElement, number>()
    let nextId = 0
    const record = (action: string, element: HTMLIFrameElement, oldValue?: string | null): void => {
      if (!ids.has(element)) {
        ids.set(element, ++nextId)
        element.addEventListener('load', () => record('load', element))
      }
      iframeTrace.push({
        action,
        id: ids.get(element),
        at: performance.now(),
        src: element.getAttribute('src'),
        oldValue,
        connected: element.isConnected,
      })
    }
    const observer = new MutationObserver((records) => {
      for (const mutation of records) {
        if (mutation.type === 'attributes' && mutation.target instanceof HTMLIFrameElement)
          record('src', mutation.target, mutation.oldValue)
        for (const [nodes, action] of [
          [mutation.removedNodes, 'remove'],
          [mutation.addedNodes, 'add'],
        ] as const) {
          for (const node of nodes) {
            if (!(node instanceof Element)) continue
            const frames =
              node instanceof HTMLIFrameElement
                ? [node]
                : Array.from(node.querySelectorAll('iframe'))
            for (const element of frames) record(action, element)
          }
        }
      }
    })
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['src'],
    })
  }
  let parentOrigin: string | undefined
  let activeSurface: string | undefined
  ;(window as unknown as { simLifecycleTrace: string[] }).simLifecycleTrace = trace
  window.addEventListener('pagehide', () => trace.push('pagehide'))
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'host.launch') {
      parentOrigin = event.origin
      activeSurface = event.data.payload?.surface
    }
    if (event.data?.type === 'local.sim.console-error')
      trace.push(JSON.stringify(event.data.payload))
    if (typeof event.data?.type === 'string')
      trace.push(`${event.data.type}:${event.data.payload?.surface ?? ''}`)
  })
  // Diagnostic only: retain every real console call and the unchanged error
  // assertion, while copying its surface identity before teardown destroys it.
  const originalError = console.error
  console.error = (...args) => {
    originalError.apply(console, args)
    if (parentOrigin && window.parent !== window)
      window.parent.postMessage(
        {
          type: 'local.sim.console-error',
          payload: { surface: activeSurface, errors: args.map(String), trace: [...trace] },
        },
        parentOrigin
      )
  }
})
const errors: string[] = []
const errorContexts: Promise<unknown>[] = []
page.on('pageerror', (error) => {
  errors.push(error.message)
  errorContexts.push(Promise.resolve({ pageError: error.stack }))
})
page.on('console', (message) => {
  if (message.type() === 'error') {
    errors.push(message.text())
    errorContexts.push(Promise.resolve({ location: message.location() }))
    const handle = message.args()[0]
    if (handle)
      errorContexts.push(
        handle
          .evaluate(() => ({
            url: window.location.href,
            lifecycle: (window as unknown as { simLifecycleTrace?: string[] }).simLifecycleTrace,
            root: document.getElementById('sim')?.firstElementChild?.className,
          }))
          .catch(() => ({ context: 'destroyed' }))
      )
  }
})
try {
  expect((await fetch(`${simServer.url.origin}/assets/agent-sim/engine.js`)).status).toBe(401)
  expect(assetReads).toBe(0)
  await page.goto(`${origin}/?view=virtual&characterDesigner=1`)
  const frame = () => page.frameLocator('iframe')
  const readyScene = async (surface: 'hq' | 'character-designer' | 'room-designer') => {
    await expect(frame().locator('canvas').first()).toBeVisible({ timeout: 60_000 })
    if (surface === 'character-designer')
      await expect(frame().locator('.character-designer-room')).toHaveAttribute(
        'aria-busy',
        'false',
        { timeout: 60_000 }
      )
    else await expect(frame().locator('[data-scene-loading]')).toHaveCount(0, { timeout: 60_000 })
  }
  await expect(
    frame().getByRole('button', { name: 'Close character designer', exact: true })
  ).toBeVisible({ timeout: 60_000 })
  await readyScene('character-designer')
  await frame().getByRole('button', { name: 'Hair', exact: true }).click()
  const hair = frame()
    .locator('[data-slot="toggle-group"][aria-label="Hair"]')
    .getByRole('button')
    .nth(1)
  await hair.click()
  await expect(hair).toHaveAttribute('aria-pressed', 'true')
  console.log('phase: edited actual private designer')
  await page.evaluate(() => {
    ;(window as unknown as { delaySimSave: boolean }).delaySimSave = true
  })
  await frame().getByRole('button', { name: 'Save & return', exact: true }).click()
  await page.waitForFunction(() =>
    Boolean((window as unknown as { releaseSimSave?: () => void }).releaseSimSave)
  )
  const newerHair = frame()
    .locator('[data-slot="toggle-group"][aria-label="Hair"]')
    .getByRole('button')
    .nth(2)
  await newerHair.click()
  await expect(newerHair).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() =>
    (window as unknown as { releaseSimSave?: () => void }).releaseSimSave?.()
  )
  await expect(
    frame().getByText('Earlier design saved. Your newer edits are not saved yet.', { exact: true })
  ).toBeAttached()
  const earlier = new URL(page.url()).searchParams.get('character')
  expect(earlier).toMatch(/^character:v1:/)
  await expect(page).toHaveURL(/characterDesigner=1/)
  await expect(frame().getByRole('button', { name: 'Reset design', exact: true })).toBeEnabled()
  console.log('phase: delayed ACK preserves newer unsaved edits and keeps designer open')
  await frame().getByRole('button', { name: 'Save & return', exact: true }).click()
  await expect(page).not.toHaveURL(/characterDesigner=1/)
  console.log('phase: save acknowledged and returned')
  const saved = new URL(page.url()).searchParams.get('character')
  expect(saved).toMatch(/^character:v1:/)
  expect(saved).not.toBe(earlier)
  await page.locator('iframe[data-agent-sim-active="true"]').waitFor({ timeout: 60_000 })
  await readyScene('hq')
  await frame().getByRole('button', { name: 'Character', exact: true }).click()
  await expect(page).toHaveURL(/characterDesigner=1/)
  console.log('phase: reopened from HQ control')
  await expect(
    frame().getByRole('button', { name: 'Close character designer', exact: true })
  ).toBeVisible({ timeout: 60_000 })
  await readyScene('character-designer')
  await page.reload()
  await expect(
    frame().getByRole('button', { name: 'Close character designer', exact: true })
  ).toBeVisible({ timeout: 60_000 })
  await readyScene('character-designer')
  expect(new URL(page.url()).searchParams.get('character')).toBe(saved)
  console.log('phase: parent reload restored ready character designer')
  for (const child of page.frames()) {
    if (child === page.mainFrame()) continue
    launches.push(
      ...(await child.evaluate(
        () =>
          (window as unknown as { testLaunches?: { surface: string; character?: string }[] })
            .testLaunches ?? []
      ))
    )
  }
  expect(launches.at(-1)?.character).toBe(saved)
  await frame().getByRole('button', { name: 'Close character designer', exact: true }).click()
  await expect(page).not.toHaveURL(/characterDesigner=1/)
  await readyScene('hq')
  console.log('phase: closed reloaded character designer into HQ')
  if (process.env.ADEA_SIM_FORCE_FRAME_MOVE) {
    const before = grants
    const previousFrame = await page.locator('iframe').getAttribute('src')
    await page.evaluate(async (asynchronous) => {
      const iframe = document.querySelector('iframe')!
      const parent = iframe.parentNode!
      parent.removeChild(iframe)
      // A timer crosses MutationObserver delivery: history must survive while
      // the frame listener is absent and the element is temporarily detached.
      if (asynchronous) await new Promise((nextTurn) => setTimeout(nextTurn, 0))
      parent.appendChild(iframe)
    }, process.env.ADEA_SIM_FORCE_FRAME_MOVE === 'async')
    await expect.poll(() => grants).toBe(before + 1)
    await expect(page.locator('iframe')).not.toHaveAttribute('src', previousFrame!)
    await readyScene('hq')
    await expect(frame().getByRole('button', { name: 'Character', exact: true })).toBeVisible()
    console.log('phase: native iframe move recovered with a fresh grant')
    const recoveredGrants = grants
    await page.evaluate(async (asynchronous) => {
      const iframe = document.querySelector('iframe')!
      const parent = iframe.parentNode!
      parent.removeChild(iframe)
      // A timer crosses MutationObserver delivery: history must survive while
      // the frame listener is absent and the element is temporarily detached.
      if (asynchronous) await new Promise((nextTurn) => setTimeout(nextTurn, 0))
      parent.appendChild(iframe)
    }, process.env.ADEA_SIM_FORCE_FRAME_MOVE === 'async')
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
    expect(grants).toBe(recoveredGrants)
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect.poll(() => grants).toBe(recoveredGrants + 1)
    await readyScene('hq')
    await expect(frame().getByRole('button', { name: 'Character', exact: true })).toBeVisible()
    console.log('phase: repeated native reload requires explicit retry and fresh grant')
  }
  await frame().getByRole('button', { name: 'Room designer', exact: true }).click()
  await expect(page).toHaveURL(/roomDesigner=1/)
  await expect(
    frame().getByRole('button', { name: 'Close room designer', exact: true })
  ).toBeVisible({ timeout: 60_000 })
  await readyScene('room-designer')
  console.log('phase: room designer ready')
  await frame().getByRole('button', { name: 'Close room designer', exact: true }).click()
  await expect(page).not.toHaveURL(/roomDesigner=1/)
  await readyScene('hq')
  console.log('phase: returned from room designer into HQ')
  await expect(frame().getByRole('button', { name: 'Character', exact: true })).toBeVisible({
    timeout: 60_000,
  })
  expect(new URL(page.url()).searchParams.get('character')).toBe(saved)
  if (process.env.ADEA_SIM_SCREENSHOT)
    await page.screenshot({ path: process.env.ADEA_SIM_SCREENSHOT })
  console.log(
    JSON.stringify({
      evidence:
        'actual built client and private export with synthetic authority/storage; local only',
      saveCloseReopenParentReload: true,
      delayedAcknowledgementPreservesEdits: true,
      roomDesignerRoundTrip: true,
      grants,
      assetReads,
      characterLength: saved!.length,
      renderingErrors: errors.length,
      iframeEvents: await page.evaluate(
        () => (window as unknown as { simIframeTrace?: unknown[] }).simIframeTrace
      ),
    })
  )
  expect(errors).toEqual([])
} catch (error) {
  console.error(
    JSON.stringify({ requests, errors, errorContexts: await Promise.all(errorContexts) })
  )
  console.error(
    JSON.stringify({
      parentUrl: page.url(),
      grants,
      assetReads,
      frames: await Promise.all(
        page.frames().map(async (child) => ({
          url: child.url(),
          body: await child
            .locator('body')
            .innerText({ timeout: 1000 })
            .catch(() => 'unavailable'),
          state: await child
            .evaluate(() => ({
              lifecycle: (window as unknown as { simLifecycleTrace?: string[] }).simLifecycleTrace,
              iframes: (window as unknown as { simIframeTrace?: unknown[] }).simIframeTrace,
              root: document.getElementById('sim')?.innerHTML.slice(0, 2500),
              ready: document.readyState,
              bodyBox: document.body.getBoundingClientRect().toJSON(),
              bodyStyle: {
                visibility: getComputedStyle(document.body).visibility,
                display: getComputedStyle(document.body).display,
              },
              buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
                label: button.getAttribute('aria-label'),
                text: button.textContent,
                hidden: button.closest('[hidden], [aria-hidden="true"]')?.tagName,
                box: button.getBoundingClientRect().toJSON(),
              })),
            }))
            .catch(() => null),
        }))
      ),
    })
  )
  console.error((await page.locator('body').innerText()).slice(0, 8000))
  throw error
} finally {
  await browser.close()
  server.stop(true)
  simServer.stop(true)
}
