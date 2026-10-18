// Optional boundary qualification while UI #416 remains unpublished. Uses its
// exact source as a temporary test dependency; changes no UI checkout or pins.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createSessionEventLog } from '../apps/desktop/shell/src/dev-runtime/harness/events.ts'

const UI_REVISION = 'f74a9ee2ab03bd3a3687d43ee9a193ac2db2a05d'
const uiSource = process.argv[process.argv.indexOf('--ui-source') + 1]
if (!process.argv.includes('--ui-source') || !uiSource)
  throw new Error(
    'Usage: bun scripts/test-runtime-transcript-scroll.mjs --ui-source PATH_TO_UI_CHECKOUT'
  )
const root = resolve(import.meta.dirname, '..')
const resolveBuildDependency = createRequire(join(root, 'packages/dev-view/package.json'))
const { createServer } = await import(resolveBuildDependency.resolve('vite'))
const { default: solid } = await import(resolveBuildDependency.resolve('vite-plugin-solid'))
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'adea-transcript-scroll-')))
const scope = { accountId: 'account-a', workspaceId: 'workspace-a', runtimeNodeId: 'node-a' }
const log = createSessionEventLog({ dataDir: temporary, scope })
const session = 'session-history-qualification'
function append() {
  const seq = BigInt(log.latestSequence(session, 1)) + 1n
  return log.append({
    runtimeSessionId: session,
    generation: 1,
    sourceEventId: `prompt-${seq}`,
    kind: 'turn.user_input',
    classification: 'workspace_private',
    payload: { text: `Prompt ${seq}` },
  })
}
for (let n = 0; n < 60; n++) append()
const readUi = (file) => {
  const result = spawnSync('git', ['-C', resolve(uiSource), 'show', `${UI_REVISION}:${file}`], {
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`Pinned UI source unavailable: ${file}`)
  return result.stdout
}
let server
let browser
let page
let phase = 'prepare'
let requests = 0
let failNext = false
try {
  symlinkSync(join(root, 'packages/dev-view/node_modules'), join(temporary, 'node_modules'), 'dir')
  const prefix = 'packages/ui/public/r/src/components/composites/message-scroller/'
  // Import-path adaptation only. Component and anchor algorithms are unchanged.
  const component = readUi(`${prefix}message-scroller.tsx`)
    .replace("'../../../lib/utils'", "'@adea-ai/ui/lib/utils'")
    .replace("'../../ui/button'", "'@adea-ai/ui/components/ui/button'")
    .replace("'../../conversation/conversation-surface'", "'@adea-ai/ui/components/conversation'")
  writeFileSync(join(temporary, 'message-scroller.tsx'), component)
  writeFileSync(join(temporary, 'scroll-anchor.ts'), readUi(`${prefix}scroll-anchor.ts`))
  writeFileSync(
    join(temporary, 'index.html'),
    '<div id="root"></div><script type="module" src="/fixture.tsx"></script>'
  )
  writeFileSync(
    join(temporary, 'fixture.tsx'),
    `
import { createSignal, For } from 'solid-js'
import { render } from 'solid-js/web'
import { MessageScroller } from './message-scroller'
import { createRuntimeHistoryLoader } from ${JSON.stringify(join(root, 'packages/dev-view/src/chat/model/history.ts'))}
import { createTranscriptAccumulator, acceptRuntimeEvent } from ${JSON.stringify(join(root, 'packages/dev-view/src/chat/model/transcript.ts'))}
import './fixture.css'
const initial = ${JSON.stringify(log.read(session, { generation: 1, fromSequence: '41', limit: 500 }))}
let start = createTranscriptAccumulator({ runtimeSessionId: ${JSON.stringify(session)}, generation: 1, fromSequence: '41' })
for (const event of initial) start = acceptRuntimeEvent(start, event)
const [state, setState] = createSignal(start)
const [armed, setArmed] = createSignal(false)
const [loading, setLoading] = createSignal(false)
const [error, setError] = createSignal(false)
const reader = createRuntimeHistoryLoader({ state, commit: setState, read: async (query) => {
  const reply = await fetch('/history', { method: 'POST', body: JSON.stringify(query) })
  if (!reply.ok) throw new Error('history unavailable')
  return reply.json()
} })
const load = async () => { setLoading(true); setError(false); try { await reader.loadOlder() } catch { setError(true) } finally { setLoading(false) } }
window.historyTest = {
  arm: () => setArmed(true), state, loading, error, close: reader.close,
  append: async () => { const event = await (await fetch('/append', { method: 'POST' })).json(); setState((previous) => acceptRuntimeEvent(previous, event)) },
  failNext: () => fetch('/fail-next', { method: 'POST' }),
}
render(() => <MessageScroller data-history-scroller="" resetKey="session:1" hasOlder={armed() && (state(), reader.hasOlder())} loadingOlder={loading()} onLoadOlder={load}>
  <For each={state().events}>{(event) => <div class="event" data-anchor-id={event.eventId} data-seq={event.seq}>{event.payload.text}</div>}</For>
</MessageScroller>, document.getElementById('root'))
`
  )
  writeFileSync(
    join(temporary, 'fixture.css'),
    `
html, body, #root { margin: 0; height: 600px; font-family: sans-serif; }
[data-slot="message-scroller"], [data-slot="conversation-surface"] { display: flex; flex-direction: column; height: 100%; min-height: 0; }
[data-history-scroller] { overflow-y: auto; flex: 1; min-height: 0; overflow-anchor: none; }
[data-slot="message-scroller-older"] { display: flex; justify-content: center; padding-block: 8px; }
/* Match the published sm control height so the loading row and button have
   the same layout contract as the real Tailwind/theme projection. */
[data-slot="message-scroller-older"] button, [data-slot="message-scroller-older"] p { display: inline-flex; align-items: center; height: 28px; box-sizing: border-box; margin: 0; padding: 0; border: 0; }
[data-slot="message-scroller-older"] svg { width: 14px; height: 14px; }
.event { height: 90px; box-sizing: border-box; border-bottom: 1px solid; padding: 12px; }
`
  )
  const historyMiddleware = (req, res, next) => {
    void handleHistoryRequest(req, res, next).catch(next)
  }
  async function handleHistoryRequest(req, res, next) {
    if (!['/history', '/append', '/fail-next'].includes(req.url)) return next()
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 4096) throw new Error('request too large')
      }
      res.setHeader('content-type', 'application/json')
      if (req.url === '/append') return void res.end(JSON.stringify(append()))
      if (req.url === '/fail-next') {
        failNext = true
        return void res.end('{}')
      }
      requests++
      await Bun.sleep(120)
      if (failNext) {
        failNext = false
        res.statusCode = 503
        return void res.end('{}')
      }
      res.end(
        JSON.stringify(log.history(session, { generation: 1, limit: 10, ...JSON.parse(body) }))
      )
    } catch {
      res.statusCode = 500
      res.end('{}')
    }
  }
  server = await createServer({
    configFile: false,
    root: temporary,
    envDir: false,
    envPrefix: [],
    plugins: [
      {
        name: 'history-qualification-endpoints',
        configureServer(vite) {
          vite.middlewares.use(historyMiddleware)
        },
      },
      solid(),
    ],
    optimizeDeps: { exclude: ['@adea-ai/ui', 'lucide-solid'] },
    resolve: {
      dedupe: ['solid-js'],
      alias: [
        {
          find: /^lucide-solid$/,
          replacement: join(root, 'apps/web/start/lucide-solid-dev-shim.jsx'),
        },
      ],
    },
    server: { host: '0.0.0.0', port: 0, fs: { allow: [temporary, root] } },
    logLevel: 'error',
  })
  await server.listen()
  const port = server.httpServer.address().port
  console.log(JSON.stringify({ phase: 'started', pid: process.pid, port, uiRevision: UI_REVISION }))
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.setDefaultTimeout(10_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}`)
  phase = 'fixture ready'
  await page.waitForFunction(() => !!window.historyTest)
  await page.waitForTimeout(150)
  const before = await page.evaluate(() => {
    const scroller = document.querySelector('[data-history-scroller]')
    scroller.scrollTop = 450
    scroller.dispatchEvent(new Event('scroll'))
    window.historyTest.arm()
    const top = scroller.getBoundingClientRect().top
    const anchor = [...scroller.querySelectorAll('[data-anchor-id]')].find(
      (element) => element.getBoundingClientRect().bottom > top
    )
    window.historyTest.anchor = anchor
    return {
      id: anchor.getAttribute('data-anchor-id'),
      offset: anchor.getBoundingClientRect().top - top,
    }
  })
  const click = () =>
    page.getByRole('button', { name: 'Load earlier messages', exact: true }).evaluate((button) => {
      button.click()
      button.click()
    })
  const settled = () =>
    page.waitForFunction(
      () =>
        !window.historyTest.loading() &&
        !!document.querySelector('[data-slot="message-scroller-older"] button')
    )
  phase = 'first load starts'
  await click()
  await page.waitForFunction(() => window.historyTest.loading())
  await page.evaluate(() => window.historyTest.append())
  phase = 'first load settles'
  await settled()
  const inspect = () =>
    page.evaluate(() => {
      const scroller = document.querySelector('[data-history-scroller]')
      const anchor = window.historyTest.anchor
      return {
        connected: anchor.isConnected,
        id: anchor.getAttribute('data-anchor-id'),
        offset: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
        seqs: [...scroller.querySelectorAll('[data-seq]')].map((element) =>
          element.getAttribute('data-seq')
        ),
        failed: window.historyTest.error(),
      }
    })
  const inserted = await inspect()
  if (
    requests !== 1 ||
    inserted.seqs.length !== 31 ||
    inserted.seqs.at(-1) !== '61' ||
    !inserted.connected ||
    Math.abs(inserted.offset - before.offset) > 1
  )
    throw new Error(
      `Backfill did not preserve anchor: ${JSON.stringify({ before, inserted, requests })}`
    )
  await page.evaluate(() => window.historyTest.failNext())
  phase = 'failed load settles'
  await click()
  phase = 'retry settles'
  await settled()
  const failed = await inspect()
  if (!failed.failed || failed.seqs.length !== 31 || Math.abs(failed.offset - before.offset) > 1)
    throw new Error('Failed load changed transcript or reader position')
  await click()
  phase = 'cancelled load starts'
  await settled()
  const retried = await inspect()
  if (
    requests !== 3 ||
    retried.seqs.length !== 41 ||
    new Set(retried.seqs).size !== 41 ||
    !retried.connected ||
    Math.abs(retried.offset - before.offset) > 1
  )
    throw new Error(
      `Retry did not preserve anchor: ${JSON.stringify({ before, retried, requests })}`
    )
  const lateResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/history' && response.status() === 200
  )
  await click()
  await page.waitForFunction(() => window.historyTest.loading())
  await page.evaluate(() => window.historyTest.close())
  await lateResponse
  await page.waitForFunction(() => !window.historyTest.loading())
  const cancelled = await inspect()
  if (
    cancelled.seqs.length !== 41 ||
    !cancelled.connected ||
    Math.abs(cancelled.offset - before.offset) > 1 ||
    errors.length
  )
    throw new Error(`Cancelled load mutated transcript: ${JSON.stringify({ cancelled, errors })}`)
  console.log(
    JSON.stringify({
      result: 'pass',
      anchorOffsetBefore: before.offset,
      anchorOffsetAfter: retried.offset,
      retainedNode: retried.connected,
      visibleEvents: retried.seqs.length,
      duplicateEvents: 0,
      requests,
      concurrentAppend: true,
      retry: true,
      cancellation: true,
    })
  )
} catch (error) {
  console.error(
    JSON.stringify({
      phase,
      requests,
      message: error.message,
      fixture: await page
        ?.evaluate(() => ({
          text: document.body.innerText.slice(0, 1000),
          loading: window.historyTest?.loading(),
          error: window.historyTest?.error(),
          events: window.historyTest?.state().events.length,
        }))
        .catch(() => undefined),
    })
  )
  throw error
} finally {
  await browser?.close()
  await server?.close()
  rmSync(temporary, { recursive: true, force: true })
}
