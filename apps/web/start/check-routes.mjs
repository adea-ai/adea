import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createLoopbackCertificate } from './loopback-tls.mjs'

// Focused boot check: without provider configuration the auth proxy must fail
// closed (503) rather than 404, proving the route is mounted.
const start = fileURLToPath(new URL('.', import.meta.url))
const web = resolve(start, '..')
await mkdir(resolve(start, '.checks'), { recursive: true })
const evidence = await mkdtemp(resolve(start, '.checks/routes-'))
const tls = createLoopbackCertificate(evidence)
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CI']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)
environment.WRANGLER_SEND_METRICS = 'false'

async function availablePort() {
  const server = createServer()
  await new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', ok)
  })
  const port = server.address().port
  await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())))
  return port
}
function localHttps(url, method = 'GET') {
  // This helper is only called with the loopback URLs allocated by this
  // process, and only trusts the certificate minted for this run.
  assert.equal(new URL(url).hostname, '127.0.0.1')
  return new Promise((ok, fail) => {
    const request = httpsRequest(url, { method, ca: tls.certificate }, (response) => {
      response.resume()
      response.once('end', () => ok({ status: response.statusCode, headers: response.headers }))
    })
    request.setTimeout(10_000, () => request.destroy(new Error('timeout')))
    request.once('error', fail)
    request.end()
  })
}
async function waitFor(probe) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch {}
    await delay(250)
  }
  throw new Error(`worker did not start; inspect ${evidence}`)
}

const [port, inspector] = await Promise.all([availablePort(), availablePort()])
const baseURL = `https://127.0.0.1:${port}`
const built = JSON.parse(await readFile(resolve(web, 'dist/server/wrangler.json'), 'utf8'))
const assetsDirectory = resolve(web, 'dist/server', built.assets.directory)
// The build emits content-hashed files under the configured assets directory
// (`start-assets` in vite.config.ts); the check asks for the file the current
// build actually produced so a renamed or restyled asset keeps the assertion
// real instead of silently requesting a stale name.
const hashedStylesheets = (await readdir(resolve(assetsDirectory, 'start-assets'))).filter((name) =>
  /-[A-Za-z0-9_-]{8}\.css$/.test(name)
)
assert.ok(hashedStylesheets.length > 0, 'the build emitted no hashed stylesheet to check')
const hashedStylesheet = `/start-assets/${hashedStylesheets.toSorted().at(-1)}`
const config = resolve(evidence, 'host.json')
await writeFile(
  config,
  JSON.stringify({
    compatibility_date: '2026-08-01',
    compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
    name: `adea-routes-${process.pid}`,
    main: resolve(web, 'dist/server', built.main),
    rules: built.rules,
    no_bundle: true,
    assets: { ...built.assets, directory: assetsDirectory },
    vars: { AUTH_TRUSTED_ORIGINS: baseURL },
  })
)
const log = createWriteStream(resolve(evidence, 'worker.log'))
const child = spawn(
  'bun',
  [
    'x',
    'wrangler',
    'dev',
    '--local',
    '--config',
    config,
    '--port',
    String(port),
    '--inspector-port',
    String(inspector),
    '--persist-to',
    resolve(evidence, 'state'),
    '--local-protocol',
    'https',
    '--https-cert-path',
    tls.certPath,
    '--https-key-path',
    tls.keyPath,
  ],
  { cwd: web, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
)
child.stdout.pipe(log)
child.stderr.pipe(log)
try {
  await waitFor(async () => (await localHttps(baseURL)).status === 200)
  const checks = {
    // Anonymous visitor on an open (no allowlist) deployment gets the workspace.
    root: (await localHttps(baseURL)).status,
    rootPost: (await localHttps(baseURL, 'POST')).status,
    signIn: (await localHttps(`${baseURL}/auth/sign-in`)).status,
    desktopComplete: (await localHttps(`${baseURL}/auth/desktop/complete`)).status,
    // Unconfigured provider must fail closed rather than 404: the route exists.
    authProxy: (await localHttps(`${baseURL}/api/auth/get-session`)).status,
    entryGate: (await localHttps(`${baseURL}/api/web-entry`)).status,
    unknownApi: (await localHttps(`${baseURL}/api/not-a-route`)).status,
    unknownPage: (await localHttps(`${baseURL}/not-a-route`)).status,
    hashedAsset: hashedStylesheet,
    hashedAssetStatus: null,
    hashedAssetCaching: null,
  }
  const asset = await new Promise((ok, fail) => {
    const request = httpsRequest(
      `${baseURL}${hashedStylesheet}`,
      { ca: tls.certificate },
      (response) => {
        response.resume()
        response.once('end', () => ok({ status: response.statusCode, headers: response.headers }))
      }
    )
    request.once('error', fail)
    request.end()
  })
  checks.hashedAssetStatus = asset.status
  checks.hashedAssetCaching = asset.headers['cache-control'] ?? null
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(checks, null, 2))
  console.log(JSON.stringify(checks, null, 2))
  assert.equal(checks.root, 200)
  assert.equal(checks.rootPost, 405)
  assert.equal(checks.signIn, 200)
  assert.equal(checks.desktopComplete, 200)
  assert.notEqual(checks.authProxy, 404)
  assert.equal(checks.entryGate, 200)
  assert.equal(checks.unknownApi, 404)
  assert.equal(checks.unknownPage, 404)
  assert.equal(
    checks.hashedAssetStatus,
    200,
    'the asset layer must serve the content-hashed stylesheet'
  )
  assert.match(
    String(checks.hashedAssetCaching),
    /immutable/,
    'content-hashed assets must carry an immutable Cache-Control'
  )
} finally {
  if (child.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
}
