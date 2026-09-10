import { chromium } from '@playwright/test'
import { parseArgs } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const { values } = parseArgs({
  options: {
    'next-url': { type: 'string' },
    'start-url': { type: 'string' },
    runs: { type: 'string', default: '5' },
    output: { type: 'string', default: 'start-preview/.checks/comparison' },
  },
})
const count = Number(values.runs)
if (!Number.isInteger(count) || count < 3 || count > 20)
  throw new Error('Use 3–20 samples per host')
const origins = Object.fromEntries(
  ['next', 'start'].map((name) => {
    const url = new URL(values[`${name}-url`])
    if (
      url.protocol !== 'https:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('Both built hosts must use isolated loopback HTTPS origins')
    }
    return [name, url.origin]
  })
)
const directory = resolve(values.output)
await mkdir(directory, { recursive: true })
const samples = { next: [], start: [] }
const browser = await chromium.launch({ headless: true })
const browserVersion = browser.version()
try {
  for (let index = 0; index < count; index++) {
    for (const name of index % 2 ? ['start', 'next'] : ['next', 'start']) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
      })
      try {
        const page = await context.newPage()
        await page.addInitScript(() => {
          const observer = new MutationObserver(() => {
            const account = document.querySelector('button[aria-label="User settings"]')
            const surface = document.querySelector(
              '.conventional-workspace:not(.conventional-workspace--loading)'
            )
            if (account?.getClientRects().length && surface?.getClientRects().length) {
              window.adeaComparisonReadyMs = performance.now()
              observer.disconnect()
            }
          })
          observer.observe(document, { subtree: true, childList: true, attributes: true })
        })
        let bootstrapRequests = 0
        const errors = []
        page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/api/workspaces/bootstrap') bootstrapRequests++
        })
        page.on('response', (response) => {
          const path = new URL(response.url()).pathname
          if (path.startsWith('/api/v1/workspaces/') && response.status() >= 400)
            errors.push(`${path}: ${response.status()}`)
        })
        const response = await page.goto(`${origins[name]}/?view=chat&scene=home`)
        if (response.status() !== 200)
          throw new Error(`${name}: root returned ${response.status()}`)
        await page.getByRole('button', { name: 'User settings' }).waitFor()
        await page
          .locator('.conventional-workspace:not(.conventional-workspace--loading)')
          .waitFor()
        await page.waitForFunction(() => typeof window.adeaComparisonReadyMs === 'number')
        const readyMs = await page.evaluate(() => window.adeaComparisonReadyMs)
        // Fixed observation window includes delayed imports equally on both hosts.
        await page.waitForTimeout(1500)
        const network = await page.evaluate(() => {
          const resources = performance.getEntriesByType('resource')
          const scripts = resources.filter((entry) => /\.js(?:\?|$)/.test(entry.name))
          return {
            javascriptBytes: scripts.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
            transferBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0),
            requests: resources.length,
            scripts: scripts.map((entry) => entry.name),
            timings: scripts.map((entry) => ({
              path: new URL(entry.name).pathname,
              startMs: entry.startTime,
              endMs: entry.responseEnd,
            })),
            navigation: performance.getEntriesByType('navigation').map((entry) => ({
              ttfbMs: entry.responseStart,
              domReadyMs: entry.domContentLoadedEventEnd,
            })),
          }
        })
        const started = performance.now()
        await page.getByRole('button', { name: 'Virtual view', exact: true }).click()
        await page.getByRole('status', { name: 'Virtual view unavailable' }).waitFor()
        await page.getByRole('button', { name: 'Chat view', exact: true }).click()
        await page
          .locator('.conventional-workspace:not(.conventional-workspace--loading)')
          .waitFor()
        if (errors.length) throw new Error(`${name} browser errors: ${errors.join('; ')}`)
        samples[name].push({
          index,
          readyMs,
          switchRoundTripMs: performance.now() - started,
          bootstrapRequests,
          ...network,
        })
        if (index === 0)
          await page.screenshot({ path: resolve(directory, `${name}-desktop.png`), fullPage: true })
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}
const median = (numbers) => {
  const sorted = numbers.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const metrics = [
  'readyMs',
  'switchRoundTripMs',
  'javascriptBytes',
  'transferBytes',
  'requests',
  'bootstrapRequests',
]
const medians = Object.fromEntries(
  Object.entries(samples).map(([name, runs]) => [
    name,
    Object.fromEntries(metrics.map((metric) => [metric, median(runs.map((run) => run[metric]))])),
  ])
)
const result = {
  instrumentation:
    'v3: live guest/database path; browser-observed DOM readiness; automation-observed view switching',
  comparison: 'retained Next host versus opt-in Start host from the same worktree',
  note: 'Unthrottled desktop lab samples over local HTTPS; fresh browser contexts, real fresh guest sessions and the same empty-workspace template, alternating order. Readiness uses a browser MutationObserver timestamp; view-switch timing includes automation overhead. Resource transfer excludes the document and is not field INP or production LCP.',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtyWorktree: Boolean(
    execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
  ),
  node: process.version,
  browserVersion,
  origins,
  samples,
  medians,
}
await writeFile(resolve(directory, 'comparison.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ medians, output: directory }, null, 2))
