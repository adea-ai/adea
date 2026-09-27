// Actual packaged client, synthetic bridge: entry and refused-bootstrap recovery
// only. No credentials, cloud calls, native authority, or PTY certification.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const client = fileURLToPath(new URL('../apps/web/dist-desktop/client/', import.meta.url))
await readFile(resolve(client, 'index.html')) // Missing artifact is a failure, never a skip.
const contentTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    if (pathname.startsWith('/api/')) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end('{"error":"Synthetic backend unavailable"}')
      return
    }
    const path = resolve(client, pathname === '/' ? 'index.html' : `.${pathname}`)
    if (!path.startsWith(resolve(client) + sep)) throw new Error('Outside fixture root')
    const body = await readFile(path)
    response.writeHead(200, {
      'content-type': contentTypes[extname(path)] ?? 'application/octet-stream',
    })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
let browser
try {
  await new Promise((complete, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', complete)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  console.log(`Owned packaged-client fixture: PID ${process.pid}, ${origin}`)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  )
  await context.addInitScript(() => {
    window.fixtureBridgeCalls = []
    window.__adeaDesktop = {
      invoke: (command) => {
        window.fixtureBridgeCalls.push(command)
        if (command === 'adea_app_version') return Promise.resolve('synthetic')
        if (command === 'desktop_user_session_load' || command === 'desktop_auth_take_callback')
          return Promise.resolve(null)
        return Promise.reject(new Error('Synthetic bridge has no native authority'))
      },
      listen: () => Promise.resolve(() => undefined),
    }
  })
  const page = await context.newPage()
  const nativeRequests = []
  const errors = []
  page.on('request', (request) => {
    if (/\/desktop-workspace-entry-[^/]+\.js$/.test(new URL(request.url()).pathname))
      nativeRequests.push(request.url())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/?view=chat`)
  await expect(
    page.getByRole('heading', { name: 'Your workspace, ready when you are.' })
  ).toBeVisible({ timeout: 15_000 })
  const retry = page.getByRole('button', { name: 'Try again' })
  await expect(retry).toBeVisible()
  expect(nativeRequests).toHaveLength(1)
  const loads = () =>
    page.evaluate(
      () =>
        window.fixtureBridgeCalls.filter(
          (command) => command === 'desktop_temporary_workspace_load'
        ).length
    )
  const before = await loads()
  expect(before).toBeGreaterThan(0)
  await retry.click()
  await expect.poll(loads).toBe(before + 1)
  await expect(retry).toBeVisible()
  expect(nativeRequests).toHaveLength(1)
  expect(errors).toEqual([])
  console.log('PASS: packaged native entry loaded once; refused bootstrap retries without remount')
} finally {
  await browser?.close()
  await new Promise((complete) => {
    server.close(complete)
    server.closeAllConnections()
  })
  console.log('Owned packaged-client fixture closed')
}
