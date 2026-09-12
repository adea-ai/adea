// M5.2 shell benchmark runner. Serves the real apps/desktop client build plus
// bench endpoints, launches each candidate shell sequentially (cold, warm, IPC),
// samples process-tree RSS, records artifact sizes, and writes results/.
//
// Usage: bun runner/run-bench.mjs [--only a,b] [--sizes-only] [--skip-build-check]

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const BENCH_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(dirname(BENCH_ROOT))
const CLIENT_DIST = join(REPO_ROOT, 'apps', 'desktop', 'dist')
const PORT = 1420
const CLIENT_URL = `http://127.0.0.1:${PORT}/`
const PROBE_URL = `http://127.0.0.1:${PORT}/__bench/probe`

const args = process.argv.slice(2)
const onlyArg = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1]
const sizesOnly = args.includes('--sizes-only')
const only = onlyArg ? onlyArg.split(',') : null

// ---------------------------------------------------------------- candidates

function existsRel(rel) {
  return existsSync(join(BENCH_ROOT, rel))
}

const candidates = [
  {
    name: 'electron',
    kind: 'primary',
    preKill: 'shell-bench-electron.app',
    launch: () => ({
      cmd: join(BENCH_ROOT, 'electron/node_modules/.bin/electron'),
      args: ['.'],
      cwd: join(BENCH_ROOT, 'electron'),
    }),
    launchIpcExtraArgs: [],
    urlArg: (url) => `--url=${url}`,
    sizes: async () => {
      const app = join(BENCH_ROOT, 'electron/release/mac-arm64/shell-bench-electron.app')
      return {
        electron_runtime_node_modules_kb: await duKb(
          join(BENCH_ROOT, 'electron/node_modules/electron/dist')
        ),
        built_app_kb: existsSync(app) ? await duKb(app) : null,
      }
    },
  },
  {
    name: 'tauri',
    kind: 'baseline',
    preKill: 'shell-bench-tauri',
    launch: () => {
      const bin = join(
        BENCH_ROOT,
        'tauri/src-tauri/target/release/bundle/macos/shell-bench-tauri.app/Contents/MacOS/shell-bench-tauri'
      )
      return { cmd: bin, args: [], cwd: dirname(bin) }
    },
    urlArg: (url) => `--url=${url}`,
    sizes: async () => {
      const app = join(
        BENCH_ROOT,
        'tauri/src-tauri/target/release/bundle/macos/shell-bench-tauri.app'
      )
      return {
        built_app_kb: existsSync(app) ? await duKb(app) : null,
        binary_kb: await duKb(join(BENCH_ROOT, 'tauri/src-tauri/target/release/shell-bench-tauri')),
      }
    },
  },
  {
    name: 'cef',
    kind: 'primary',
    launch: () => {
      const bin = join(
        BENCH_ROOT,
        'cef/target/bundle/shell-bench-cef.app/Contents/MacOS/shell-bench-cef'
      )
      return { cmd: bin, args: [], cwd: dirname(bin) }
    },
    urlArg: (url) => `--url=${url}`,
    sizes: async () => {
      const app = join(BENCH_ROOT, 'cef/target/bundle/shell-bench-cef.app')
      return {
        built_app_kb: existsSync(app) ? await duKb(app) : null,
        cef_distribution_kb: await duKb(cefDistDir()),
      }
    },
  },
  {
    name: 'electrobun-bun',
    kind: 'longshot',
    preKill: 'hello-world.app',
    launch: () => {
      const bin = join(
        BENCH_ROOT,
        'electrobun/shell-bench-electrobun-bun/build/stable-macos-arm64/hello-world.app/Contents/MacOS/launcher'
      )
      return { cmd: bin, args: [], cwd: dirname(dirname(dirname(bin))) }
    },
    envUrl: 'BENCH_URL', // bun entry: url: process.env.BENCH_URL ?? views://...
    ipc: false, // electrobun RPC not probed (longshot)
    sizes: async () => ({
      built_app_kb: await duKb(
        join(
          BENCH_ROOT,
          'electrobun/shell-bench-electrobun-bun/build/stable-macos-arm64/hello-world.app'
        )
      ),
    }),
  },
  {
    name: 'deno-cef',
    kind: 'longshot',
    launch: () => {
      const bin = join(BENCH_ROOT, 'deno/dist/shell-bench-deno-cef.app.app/Contents/MacOS/laufey')
      return { cmd: bin, args: [], cwd: dirname(bin) }
    },
    ipc: false, // deno desktop bindings not probed (longshot)
    sizes: async () => ({
      built_app_kb: await duKb(join(BENCH_ROOT, 'deno/dist/shell-bench-deno-cef.app.app')),
    }),
  },
  {
    name: 'nwjs',
    kind: 'longshot',
    launch: () => ({
      cmd: join(BENCH_ROOT, 'nwjs/node_modules/.bin/nw'),
      args: ['.'],
      cwd: join(BENCH_ROOT, 'nwjs'),
    }),
    urlArg: (url) => `--url=${url}`,
    ipc: false, // no message-port bridge; node-in-page is not comparable
    prepare: async (url) => {
      writeFileSync(
        join(BENCH_ROOT, 'nwjs/url.js'),
        `window.__BENCH_URL = ${JSON.stringify(url)};\n`
      )
    },
    sizes: async () => ({
      nw_runtime_kb: await duKb(join(BENCH_ROOT, 'nwjs/node_modules/nw/nwjs-v0.115.0-osx-arm64')),
    }),
  },
  {
    name: 'chrome-app',
    kind: 'longshot',
    launch: () => ({
      cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${chromeProfileDir()}`,
      ],
      cwd: BENCH_ROOT,
    }),
    urlArg: (url) => `--app=${url}`,
    ipc: false, // plain Chrome; no shell bridge
    sizes: async () => ({ marginal_kb: 0 }),
  },
]

let chromeProfileCounter = 0
function chromeProfileDir() {
  return `/tmp/shell-bench-chrome-${process.pid}-${chromeProfileCounter++}`
}

// cef-dll-sys downloads/extracts the CEF distribution under its build OUT_DIR
function cefDistDir() {
  if (!cefDistDir.cache) {
    const buildBase = join(BENCH_ROOT, 'cef/target/release/build')
    let found = null
    try {
      for (const entry of readdirSync(buildBase)) {
        const candidate = join(buildBase, entry, 'out')
        if (existsSync(join(candidate, 'cef_binary_version.json'))) {
          found = join(candidate, 'cef_binary_*')
          break
        }
      }
    } catch {
      /* not built yet */
    }
    cefDistDir.cache = found
  }
  return cefDistDir.cache
}

// ------------------------------------------------------------------ serving

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
}

const state = {
  currentRun: null, // { candidate, phase, spawnedAtMs, resolve }
  ipcResult: null,
}

const CLOUD_ORIGIN = 'https://adea.dev'

function injectIndex(html) {
  if (html.includes('/__bench/inject.js')) return html
  return html.replace('</body>', '<script src="/__bench/inject.js"></script></body>')
}

// The client bundle bakes the cloud origin at build time; rewrite it to
// same-origin so the bench server can proxy it (the CP rejects foreign origins).
function rewriteCloudOrigin(js) {
  return js.split(CLOUD_ORIGIN).join(`http://127.0.0.1:${PORT}`)
}

async function proxyToCloud(req, res, url) {
  const chunks = []
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const c of req) chunks.push(c)
  }
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const k = key.toLowerCase()
    if (['host', 'referer', 'connection', 'content-length'].includes(k)) continue
    if (Array.isArray(value)) headers[key] = value.join(', ')
    else headers[key] = value
  }
  // Bench-only: the hosted CP rejects desktop-client bootstrap without a device
  // credential (real app mints one via keyring — M5.3 item). Bench shells run
  // as browser-type clients for the workspace service.
  // bench: keep x-adea-client as desktop (session-authenticated)
  try {
    const upstream = await fetch(`${CLOUD_ORIGIN}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    })
    console.log(
      `[proxy] ${req.method} ${url.pathname} -> ${upstream.status} (${state.currentRun?.candidate ?? '-'}/${state.currentRun?.phase ?? '-'})`
    )
    if (upstream.status >= 400) {
      const errBody = Buffer.from(await upstream.arrayBuffer())
      console.log(
        `[proxy] error body: ${errBody.toString('utf8').slice(0, 300)} | req headers: ${JSON.stringify(headers).slice(0, 400)}`
      )
      for (const [key, value] of upstream.headers) {
        const k = key.toLowerCase()
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k))
          continue
        responseHeaders[key] = value
      }
      responseHeaders['content-length'] = String(errBody.length)
      res.writeHead(upstream.status, responseHeaders)
      res.end(errBody)
      return
    }
    const responseHeaders = {}
    for (const [key, value] of upstream.headers) {
      const k = key.toLowerCase()
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k))
        continue
      responseHeaders[key] = value
    }
    res.writeHead(upstream.status, responseHeaders)
    if (upstream.body) {
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    }
    res.end()
  } catch {
    res.writeHead(502)
    res.end()
  }
}

async function serveFile(res, filePath, inject) {
  let body = await readFile(filePath)
  if (inject && filePath.endsWith('.html')) {
    body = Buffer.from(injectIndex(body.toString('utf8')))
  } else if (inject && filePath.endsWith('.js')) {
    body = Buffer.from(rewriteCloudOrigin(body.toString('utf8')))
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    if (url.pathname === '/__bench/ready' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (state.currentRun && state.currentRun.phase === 'start') {
        const t = Date.now()
        state.currentRun.ready = {
          ...payload,
          readyWallMs: t - state.currentRun.spawnedAtMs,
        }
        state.currentRun.phase = 'settling'
        state.currentRun.resolve?.()
      }
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === '/__bench/workspace' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (state.currentRun && state.currentRun.phase === 'settling') {
        state.currentRun.workspace = payload
        state.currentRun.phase = 'loaded-wait'
        state.currentRun.workspaceResolve?.()
      }
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === '/__bench/ipc' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      state.ipcResult = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === '/__bench/inject.js') {
      await serveFile(res, join(BENCH_ROOT, 'bench', 'inject.js'), false)
      return
    }
    if (url.pathname === '/__bench/probe') {
      await serveFile(res, join(BENCH_ROOT, 'bench', 'probe.html'), false)
      return
    }
    if (url.pathname === '/__bench/health') {
      res.writeHead(200)
      res.end('ok')
      return
    }
    // Cloud passthrough: anything that is not a static client asset is proxied
    // to the cloud origin (same-origin from the page's perspective).
    const wantsHtml = (req.headers.accept || '').includes('text/html')
    const isAsset = extname(url.pathname) !== ''
    if (req.method !== 'GET' || url.pathname.startsWith('/api') || (!isAsset && !wantsHtml)) {
      await proxyToCloud(req, res, url)
      return
    }
    // static client from apps/desktop/dist
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    let filePath = join(CLIENT_DIST, rel)
    if (!filePath.startsWith(CLIENT_DIST)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (existsSync(filePath) && (await stat(filePath)).isDirectory()) {
      filePath = join(filePath, 'index.html')
    }
    if (!existsSync(filePath)) {
      // SPA fallback for client-side routes
      filePath = join(CLIENT_DIST, 'index.html')
    }
    await serveFile(res, filePath, true)
  } catch {
    res.writeHead(500)
    res.end()
  }
})

// ---------------------------------------------------------------- measurement

async function psSnapshot() {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const out = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,rss='])
  const rows = []
  for (const line of out.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length === 3) rows.push({ pid: +parts[0], ppid: +parts[1], rssKb: +parts[2] })
  }
  return rows
}

function treeRss(rows, rootPid) {
  const byParent = new Map()
  for (const r of rows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, [])
    byParent.get(r.ppid).push(r.pid)
  }
  let total = 0
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.pop()
    const row = rows.find((r) => r.pid === pid)
    if (row) total += row.rssKb
    for (const child of byParent.get(pid) || []) {
      if (!seen.has(child)) {
        seen.add(child)
        queue.push(child)
      }
    }
  }
  return total // KB
}

function killTree(pid) {
  // detached spawn creates a new process group: the negative pid signals the
  // whole group. Electron/Electrobun child trees would otherwise survive and
  // poison later runs via single-instance handoff.
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      spawn('kill', ['-9', String(pid)])
    } catch {
      /* already gone */
    }
  }
  try {
    spawn('pkill', ['-9', '-P', String(pid)])
  } catch {
    /* best effort */
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function waitForReady(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (state.currentRun) state.currentRun.resolve = null
      resolve(null)
    }, timeoutMs)
    state.currentRun.resolve = () => {
      clearTimeout(timer)
      resolve(state.currentRun.ready)
    }
  })
}

async function waitForWorkspace(timeoutMs) {
  if (state.currentRun.workspace) return state.currentRun.workspace
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.currentRun.workspaceResolve = null
      resolve(null)
    }, timeoutMs)
    state.currentRun.workspaceResolve = () => {
      clearTimeout(timer)
      resolve(state.currentRun.workspace)
    }
  })
}

const samples = []
let sampler = null
function startSampling(rootPid) {
  samples.length = 0
  sampler = setInterval(async () => {
    try {
      const kb = treeRss(await psSnapshot(), rootPid)
      if (kb > 0) samples.push(kb)
    } catch {
      /* transient ps failure */
    }
  }, 250)
}
function stopSampling() {
  clearInterval(sampler)
}

async function runPhase(candidate, phase, url) {
  if (candidate.preKill) spawn('pkill', ['-9', '-f', candidate.preKill])
  if (candidate.prepare) await candidate.prepare(url)
  const { cmd, args: baseArgs, cwd } = candidate.launch()
  const spawnEnv = candidate.envUrl ? { ...process.env, [candidate.envUrl]: url } : undefined
  const urlArg = candidate.envUrl ? null : (candidate.urlArg?.(url) ?? null)
  const argv = [...baseArgs]
  if (urlArg) argv.push(urlArg)

  state.currentRun = { candidate: candidate.name, phase: 'start', spawnedAtMs: Date.now() }
  const proc = spawn(cmd, argv, { cwd, stdio: 'ignore', detached: true, env: spawnEnv })
  const rootPid = proc.pid
  startSampling(rootPid)

  const readyPromise = waitForReady(45_000)
  const ready = await readyPromise
  if (!ready) {
    stopSampling()
    killTree(rootPid)
    await new Promise((r) => setTimeout(r, 500))
    return { ok: false, error: 'ready timeout (45s)' }
  }

  // loaded phase: wait for guest workspace boot + virtual engine, then sample
  const workspace = await waitForWorkspace(90_000)
  let loaded = { ok: false, error: 'workspace boot timeout (90s)' }
  if (workspace) {
    const workspaceSampleIdx = samples.length
    await new Promise((r) => setTimeout(r, 8000))
    const loadedWindow = samples.slice(workspaceSampleIdx).sort((a, b) => a - b)
    loaded = {
      ok: true,
      loadedRssKb: loadedWindow.length ? loadedWindow[Math.floor(loadedWindow.length / 2)] : null,
      loadedPeakKb: loadedWindow.length ? Math.max(...loadedWindow) : null,
    }
  }
  stopSampling()
  const idleStart = Math.floor(samples.length * 0.6)
  const idleWindow = samples.slice(idleStart).sort((a, b) => a - b)
  const result = {
    ok: true,
    readyWallMs: ready.readyWallMs,
    loadEventEndMs: ready.loadEventEndMs,
    domContentLoadedEventEndMs: ready.domContentLoadedEventEndMs,
    workspaceBootedMs: workspace?.bootedMs ?? null,
    workspaceWallMs: workspace ? Date.now() - state.currentRun.spawnedAtMs : null,
    virtualEnginePresent: workspace ? !!workspace.virtualEnginePresent : null,
    idleRssKb: idleWindow.length ? idleWindow[Math.floor(idleWindow.length / 2)] : null,
    peakRssKb: samples.length ? Math.max(...samples) : null,
    ...loaded,
  }
  killTree(rootPid)
  await new Promise((r) => setTimeout(r, 800))
  return result
}

async function runIpc(candidate) {
  if (candidate.ipc === false)
    return { bridge: null, note: 'no shell bridge (N/A for this candidate)' }
  if (candidate.prepare) await candidate.prepare(PROBE_URL)
  if (candidate.preKill) spawn('pkill', ['-9', '-f', candidate.preKill])
  const { cmd, args: baseArgs, cwd } = candidate.launch()
  const spawnEnv = candidate.envUrl ? { ...process.env, [candidate.envUrl]: PROBE_URL } : undefined
  const urlArg = candidate.envUrl ? null : (candidate.urlArg?.(PROBE_URL) ?? null)
  const argv = [...baseArgs]
  if (urlArg) argv.push(urlArg)

  state.ipcResult = null
  const proc = spawn(cmd, argv, { cwd, stdio: 'ignore', detached: true, env: spawnEnv })
  const ok = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000)
    const check = setInterval(() => {
      if (state.ipcResult) {
        clearInterval(check)
        clearTimeout(timer)
        resolve(true)
      }
    }, 100)
  })
  killTree(proc.pid)
  await new Promise((r) => setTimeout(r, 800))
  if (!ok || !state.ipcResult?.samplesUs) {
    return {
      bridge: state.ipcResult?.bridge ?? null,
      note: 'ipc probe timeout or no bridge detected',
    }
  }
  const s = [...state.ipcResult.samplesUs].sort((a, b) => a - b)
  const mean = Math.round(s.reduce((a, b) => a + b, 0) / s.length)
  return {
    bridge: state.ipcResult.bridge,
    count: s.length,
    p50Us: percentile(s, 50),
    p95Us: percentile(s, 95),
    meanUs: mean,
  }
}

async function duKb(path) {
  if (!existsSync(path)) return null
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    const out = await promisify(execFile)('du', ['-sk', path])
    return parseInt(out.stdout.split('\t')[0], 10)
  } catch {
    return null
  }
}

// --------------------------------------------------------------------- main

async function main() {
  if (!existsSync(join(CLIENT_DIST, 'index.html'))) {
    console.error(
      `client dist missing at ${CLIENT_DIST} — run \`bun run build\` in apps/desktop first`
    )
    process.exit(1)
  }
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const selected = candidates.filter((c) => !only || only.includes(c.name))
  const results = []

  for (const candidate of selected) {
    const launch = candidate.launch()
    if (!existsSync(launch.cmd)) {
      console.error(`[skip] ${candidate.name}: launch binary missing (${launch.cmd})`)
      results.push({
        candidate: candidate.name,
        kind: candidate.kind,
        ok: false,
        error: 'binary missing',
      })
      continue
    }
    console.log(`\n=== ${candidate.name} (${candidate.kind}) ===`)
    const cold = await runPhase(candidate, 'cold', CLIENT_URL)
    console.log('  cold :', JSON.stringify(cold))
    let warm = { ok: false, error: 'cold failed' }
    if (cold.ok) {
      warm = await runPhase(candidate, 'warm', CLIENT_URL)
      console.log('  warm :', JSON.stringify(warm))
    }
    const ipc = await runIpc(candidate)
    console.log('  ipc  :', JSON.stringify(ipc))
    let sizes = {}
    try {
      sizes = await candidate.sizes()
    } catch (e) {
      sizes = { error: String(e) }
    }
    results.push({ candidate: candidate.name, kind: candidate.kind, cold, warm, ipc, sizes })
  }

  await mkdir(join(BENCH_ROOT, 'results'), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outFile = join(BENCH_ROOT, 'results', `bench-${stamp}.json`)
  await writeFile(
    outFile,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), clientDist: CLIENT_DIST, results },
      null,
      2
    )
  )

  console.log(`\n--- results written to ${outFile} ---`)
  for (const r of results) {
    console.log(`\n${r.candidate} [${r.kind}]`)
    console.log(
      `  cold: ${r.cold?.readyWallMs ?? r.cold?.error} ms wall / ${r.cold?.loadEventEndMs ?? '?'} ms loadEventEnd`
    )
    if (r.warm) console.log(`  warm: ${r.warm.readyWallMs ?? r.warm.error} ms wall`)
    if (r.ipc) console.log(`  ipc : ${JSON.stringify(r.ipc)}`)
    if (r.sizes) console.log(`  size: ${JSON.stringify(r.sizes)}`)
    if (r.cold?.idleRssKb)
      console.log(`  rss : idle ${r.cold.idleRssKb} KB / peak ${r.cold.peakRssKb} KB`)
  }
  server.close()
  process.exit(0)
}

await main()
