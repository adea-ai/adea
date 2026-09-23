// M15 (#301) performance baseline: the web app's build/artifact/transport
// numbers plus browser paint metrics, recorded against a clean main checkout
// and gated where the numbers are stable enough to gate.
//
// What it measures (the issue's acceptance list):
//   - cold and warm production build times, with the local Vite dep cache
//     cleared for the cold run and restored for the warm one;
//   - deploy artifact sizes SEPARATED from local build caches (dist/ totals,
//     the client JS surface, the worker entry, the largest client chunks);
//   - local TTFB against the built Worker booted through wrangler;
//   - browser LCP and CLS on the built app, plus an event-timing INP proxy
//     from a scripted interaction burst (labeled as a proxy: real INP needs
//     field data, not a lab run).
//
// Existing named gates are invoked rather than duplicated, so budget numbers
// live in exactly one place:
//   - `bun run --cwd apps/web start:check-bundle` (client JS bytes + file count)
//   - `bun scripts/check-dev-view-bundle.mjs` (the lazy Dev View chunk)
//
// Exit codes: 0 = measured and every gate passed; 1 = lane failure; 2 = a
// budget gate failed.
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

import { writeLaneSummary } from './dev-runtime-lane-report.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(root, 'apps/web')
const startedAt = new Date()

// Budgets for the numbers this lane owns. The client-side byte/file budgets
// and the Dev View chunk budget stay in their own gates (invoked below); these
// cover what only this lane measures, with headroom for a busy machine.
const BUDGETS = {
  /** Local TTFB against the built Worker on loopback. */
  ttfbMedianMs: 300,
  /** Largest Contentful Paint on the pinned Chromium, cold cache. */
  lcpMs: 4_000,
  /** Cumulative Layout Shift on the same run. */
  cls: 0.15,
  /** Event-timing proxy for INP: worst scripted interaction. */
  interactionWorstMs: 500,
}

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable'

async function availablePort() {
  while (true) {
    const server = createServer()
    await new Promise((ok, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', ok)
    })
    const port = server.address().port
    await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())))
    return port
  }
}

async function directoryBytes(directory) {
  let total = 0
  let files = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        try {
          total += (await stat(full)).size
          files += 1
        } catch {
          /* vanished between listing and stat */
        }
      }
    }
  }
  await walk(directory)
  return { bytes: total, files }
}

async function listFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(full)))
    else files.push(full)
  }
  return files
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}

function timedBuild() {
  const start = performance.now()
  const result = run('bun', ['run', 'build'], web)
  return {
    elapsedMs: Math.round(performance.now() - start),
    exitCode: result.status ?? 1,
    stderrTail: (result.stderr ?? '').trim().split('\n').slice(-3).join('\n'),
  }
}

async function measureBuilds() {
  const dist = path.join(web, 'dist')
  // The local Vite dep cache is a build cache, not an artifact: clear it for
  // the cold run so the number includes dependency optimization, and leave it
  // in place for the warm run.
  const viteCache = path.join(root, 'node_modules/.vite')
  const webViteCache = path.join(web, '.vite')
  const cacheBackup = path.join(root, '.perf-vite-cache-backup')

  await rm(dist, { recursive: true, force: true })
  if (existsSync(viteCache)) {
    await rm(cacheBackup, { recursive: true, force: true })
    await cp(viteCache, cacheBackup, { recursive: true })
    await rm(viteCache, { recursive: true, force: true })
  }
  await rm(webViteCache, { recursive: true, force: true })

  const cold = timedBuild()
  // The second build runs with the dep cache restored. This stack has no
  // incremental rebuild cache (Vite re-transforms every module), so this is a
  // cache-warm full build, not an incremental one — the old 0.07s figure it
  // gets compared against was Next's incremental rebuild.
  const rebuild = timedBuild()

  if (existsSync(cacheBackup)) {
    await rm(viteCache, { recursive: true, force: true })
    await cp(cacheBackup, viteCache, { recursive: true })
    await rm(cacheBackup, { recursive: true, force: true })
  }
  return { cold, rebuild }
}

/** Vite's own dep cache inside the build tree: a build cache, not an artifact. */
function isBuildCache(file) {
  return file.includes(`${path.sep}.vite${path.sep}`) || file.endsWith('.vite')
}

/** A local-only file that must never count as deploy output. */
function isLocalOnlyFile(file) {
  return path.basename(file) === '.dev.vars'
}

async function measureArtifacts() {
  const dist = path.join(web, 'dist')
  const client = path.join(dist, 'client')
  const startAssets = path.join(client, 'start-assets')
  const clientJs = (await listFiles(startAssets)).filter((file) => file.endsWith('.js'))
  const jsSizes = await Promise.all(
    clientJs.map(async (file) => ({
      file: path.relative(startAssets, file),
      bytes: (await stat(file)).size,
    }))
  )
  jsSizes.sort((left, right) => right.bytes - left.bytes)
  const workerEntryPath = path.join(dist, 'server/index.js')
  const workerEntry = existsSync(workerEntryPath)
    ? { file: 'server/index.js', bytes: (await stat(workerEntryPath)).size }
    : null

  // Deploy artifacts vs. everything else the build tree carries: Vite's own
  // dep cache and a local `.dev.vars` are not deployable output. The issue's
  // "separate deploy artifacts from local build caches" criterion is about
  // exactly this split, so the lane measures it instead of implying it.
  const allFiles = await listFiles(dist)
  let deployBytes = 0
  let cacheBytes = 0
  const flagged = []
  for (const file of allFiles) {
    const size = (await stat(file)).size
    if (isBuildCache(file)) cacheBytes += size
    else if (isLocalOnlyFile(file)) flagged.push(path.relative(dist, file))
    else deployBytes += size
  }
  return {
    dist: await directoryBytes(dist),
    client: await directoryBytes(client),
    deployBytes,
    cacheBytes,
    nonDeployFiles: flagged,
    clientJs: {
      files: jsSizes.length,
      bytes: jsSizes.reduce((sum, entry) => sum + entry.bytes, 0),
    },
    largestChunks: jsSizes.slice(0, 5),
    workerEntry,
  }
}

function startPreview(port) {
  const environment = {
    ...Object.fromEntries(
      ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'].map((key) => [
        key,
        process.env[key] ?? '',
      ])
    ),
    WRANGLER_SEND_METRICS: 'false',
    DATABASE_URL,
    DATABASE_URL_UNPOOLED: DATABASE_URL,
  }
  const child = spawn(
    'bunx',
    ['wrangler', 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1'],
    { cwd: web, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))
  return { child, output: () => output }
}

async function measureTtfb(port) {
  const url = `http://127.0.0.1:${port}/`
  const deadline = Date.now() + 90_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status < 500) {
        ready = true
        break
      }
    } catch {
      /* still booting */
    }
    await delay(500)
  }
  if (!ready) return null
  // One warm-up request, then the measured sample.
  await fetch(url, { redirect: 'manual' }).catch(() => undefined)
  const samples = []
  for (let index = 0; index < 20; index += 1) {
    const start = performance.now()
    const response = await fetch(url, { redirect: 'manual' })
    await response.arrayBuffer()
    samples.push(performance.now() - start)
    if (!response.ok && response.status !== 307) {
      return { error: `unexpected status ${response.status}` }
    }
  }
  samples.sort((left, right) => left - right)
  return {
    samples: samples.length,
    minMs: Number(samples[0].toFixed(1)),
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(1)),
    p95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(1)),
  }
}

async function measureBrowser(port) {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  await page.addInitScript(() => {
    const buffer = { lcp: 0, cls: 0, events: [] }
    // eslint-disable-next-line no-underscore-dangle
    window.__perfBuffer = buffer
    try {
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) buffer.lcp = Math.max(buffer.lcp, entry.startTime)
      }).observe({ type: 'largest-contentful-paint', buffered: true })
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          if (!entry.hadRecentInput) buffer.cls += entry.value
        }
      }).observe({ type: 'layout-shift', buffered: true })
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) buffer.events.push(entry.duration)
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 })
    } catch {
      /* older engines: metrics stay zero and the lane reports them as such */
    }
  })

  const navigation = await page.goto(`http://127.0.0.1:${port}/`, {
    waitUntil: 'load',
    timeout: 60_000,
  })
  const navTiming = await page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0]
    return entry
      ? {
          ttfbMs: Number((entry.responseStart - entry.requestStart).toFixed(1)),
          domContentLoadedMs: Number(entry.domContentLoadedEventEnd.toFixed(1)),
          loadMs: Number(entry.loadEventEnd.toFixed(1)),
          transferBytes: entry.transferSize,
        }
      : null
  })

  // Scripted interaction burst: the worst event-timing duration is an INP
  // proxy, not field INP.
  const interactionTargets = [
    () =>
      page
        .getByRole('button', { name: /search/i })
        .first()
        .click({ timeout: 5_000 }),
    () => page.keyboard.press('Escape'),
    () =>
      page
        .getByRole('button', { name: /user settings/i })
        .first()
        .click({ timeout: 5_000 }),
    () => page.keyboard.press('Escape'),
  ]
  for (const act of interactionTargets) {
    try {
      await act()
      await page.waitForTimeout(250)
    } catch {
      /* a target may not exist on this surface; the burst continues */
    }
  }
  await page.waitForTimeout(1_000)
  const metrics = await page.evaluate(() => {
    // eslint-disable-next-line no-underscore-dangle
    const buffer = window.__perfBuffer
    const events = buffer?.events ?? []
    return {
      lcpMs: Math.round(buffer?.lcp ?? 0),
      cls: Number((buffer?.cls ?? 0).toFixed(4)),
      interactionCount: events.length,
      interactionWorstMs: events.length ? Math.round(Math.max(...events)) : 0,
    }
  })
  await browser.close()
  return { status: navigation?.status() ?? 0, navTiming, ...metrics }
}

async function main() {
  const results = { gates: {}, measurements: {}, failures: [] }

  const builds = await measureBuilds()
  results.measurements.builds = builds
  if (builds.cold.exitCode !== 0 || builds.rebuild.exitCode !== 0) {
    results.failures.push('production build failed')
  }
  results.measurements.artifacts = await measureArtifacts()

  // Named gates stay authoritative: run them and record their verdict.
  const bundleGate = run('bun', ['run', 'start:check-bundle'], web)
  results.gates.clientBundle = {
    exitCode: bundleGate.status ?? 1,
    report: (bundleGate.stdout ?? '').trim().split('\n').slice(-1)[0],
  }
  const devViewGate = run('bun', ['scripts/check-dev-view-bundle.mjs'], root)
  results.gates.devViewChunk = {
    exitCode: devViewGate.status ?? 1,
    report: (devViewGate.stdout ?? '').trim().split('\n').slice(-1)[0],
  }
  if (results.gates.clientBundle.exitCode !== 0)
    results.failures.push('client bundle budget gate failed')
  if (results.gates.devViewChunk.exitCode !== 0)
    results.failures.push('Dev View chunk budget gate failed')

  // Deploy-artifact hygiene: the only non-deploy file the build tree may carry
  // is the Cloudflare Vite plugin's local `.dev.vars` copy (gitignored, needed
  // for local preview, excluded from the deploy byte count above). Anything else
  // appearing there means a build step started emitting something that would
  // travel with a deploy.
  const allowedNonDeploy = new Set(['server/.dev.vars', `server${path.sep}.dev.vars`])
  const unexpectedNonDeploy = results.measurements.artifacts.nonDeployFiles.filter(
    (file) => !allowedNonDeploy.has(file)
  )
  if (unexpectedNonDeploy.length > 0)
    results.failures.push(
      `unexpected non-deploy file(s) in the build tree: ${unexpectedNonDeploy.join(', ')}`
    )

  const port = await availablePort()
  const preview = startPreview(port)
  try {
    const ttfb = await measureTtfb(port)
    results.measurements.ttfb = ttfb
    if (!ttfb) {
      results.failures.push('the built Worker never answered on loopback')
    } else if (ttfb.medianMs > BUDGETS.ttfbMedianMs) {
      results.failures.push(`TTFB median ${ttfb.medianMs}ms exceeds ${BUDGETS.ttfbMedianMs}ms`)
    }
    if (ttfb) {
      const browserMetrics = await measureBrowser(port)
      results.measurements.browser = browserMetrics
      if (browserMetrics.lcpMs > BUDGETS.lcpMs)
        results.failures.push(`LCP ${browserMetrics.lcpMs}ms exceeds ${BUDGETS.lcpMs}ms`)
      if (browserMetrics.cls > BUDGETS.cls)
        results.failures.push(`CLS ${browserMetrics.cls} exceeds ${BUDGETS.cls}`)
      if (browserMetrics.interactionWorstMs > BUDGETS.interactionWorstMs)
        results.failures.push(
          `worst scripted interaction ${browserMetrics.interactionWorstMs}ms exceeds ${BUDGETS.interactionWorstMs}ms`
        )
    }
  } finally {
    preview.child.kill('SIGTERM')
    await delay(500)
    if (!preview.child.killed) preview.child.kill('SIGKILL')
  }

  results.budgets = BUDGETS
  await mkdir(path.join(root, 'artifacts/perf'), { recursive: true })
  const artifact = path.join(root, 'artifacts/perf/web-baseline.json')
  await writeFile(
    artifact,
    `${JSON.stringify({ measuredAt: startedAt.toISOString(), ...results }, null, 2)}\n`
  )

  console.log('')
  console.log('M15 web baseline')
  console.log(`  cold build            ${builds.cold.elapsedMs} ms (dep cache cleared)`)
  console.log(
    `  cache-warm rebuild    ${builds.rebuild.elapsedMs} ms (full rebuild, no incremental cache)`
  )
  console.log(
    `  deploy bytes          ${results.measurements.artifacts.deployBytes} (cache ${results.measurements.artifacts.cacheBytes} excluded)`
  )
  if (results.measurements.artifacts.nonDeployFiles.length > 0)
    console.log(
      `  flagged non-deploy    ${results.measurements.artifacts.nonDeployFiles.join(', ')}`
    )
  console.log(
    `  deploy artifact       ${results.measurements.artifacts.dist.bytes} bytes (${results.measurements.artifacts.dist.files} files)`
  )
  console.log(
    `  client JS             ${results.measurements.artifacts.clientJs.bytes} bytes / ${results.measurements.artifacts.clientJs.files} files`
  )
  console.log(
    `  worker entry          ${results.measurements.artifacts.workerEntry?.bytes ?? 'n/a'} bytes`
  )
  if (results.measurements.ttfb)
    console.log(
      `  local TTFB            min ${results.measurements.ttfb.minMs} / median ${results.measurements.ttfb.medianMs} / p95 ${results.measurements.ttfb.p95Ms} ms`
    )
  if (results.measurements.browser) {
    const browser = results.measurements.browser
    console.log(
      `  browser nav           TTFB ${browser.navTiming?.ttfbMs ?? 'n/a'} ms, DCL ${browser.navTiming?.domContentLoadedMs ?? 'n/a'} ms, load ${browser.navTiming?.loadMs ?? 'n/a'} ms`
    )
    console.log(`  LCP / CLS             ${browser.lcpMs} ms / ${browser.cls}`)
    console.log(
      `  interaction proxy     worst ${browser.interactionWorstMs} ms over ${browser.interactionCount} event-timing entries`
    )
  }
  console.log(
    `  gates                 client ${results.gates.clientBundle.exitCode === 0 ? 'pass' : 'FAIL'}, dev-view chunk ${results.gates.devViewChunk.exitCode === 0 ? 'pass' : 'FAIL'}`
  )
  console.log(`  artifact              ${path.relative(root, artifact)}`)

  await writeLaneSummary('web-performance', {
    command: 'bun run test:performance:web',
    status: results.failures.length === 0 ? 'passed' : 'failed',
    startedAt,
    details: results,
    dir: 'artifacts/perf',
  })
  if (results.failures.length > 0) {
    for (const failure of results.failures) console.error(`M15 baseline gate failed: ${failure}`)
    process.exit(2)
  }
}

await main()
