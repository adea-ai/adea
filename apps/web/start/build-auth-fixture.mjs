// Builds the auth fixture: the app build with the loopback recording transport in
// place of the production module, written to start/.checks/auth-fixture/dist. The
// production dist/ is never written. Every Vite build of this app rewrites the
// Cloudflare deploy redirect (.wrangler/deploy/config.json) to its own output, so
// the redirect is restored byte-for-byte afterwards and an ordinary deploy still
// resolves to the production output.
//
// Interruption: SIGINT, SIGTERM and SIGHUP stop every owned child process group
// and wait for it to exit before the redirect is restored. A SIGKILL of this
// script cannot run any handler; the next ordinary build rewrites the redirect.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { findFixtureMarkers } from './auth-fixture-markers.mjs'

const start = dirname(fileURLToPath(import.meta.url))
const web = resolve(start, '..')
const production = resolve(web, 'dist')
const fixture = resolve(start, '.checks/auth-fixture/dist')
const redirect = resolve(web, '.wrangler/deploy/config.json')

// Only a missing file means "absent". Any other read error fails the build; it is
// never treated as absence, which would delete a redirect that may still exist.
async function readIfPresent(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function digestTree(directory) {
  const digests = new Map()
  async function walk(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else
        digests.set(
          relative(directory, path),
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex')
        )
    }
  }
  await walk(directory)
  return digests
}

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => controller.abort(new Error(`interrupted by ${signal}`)))

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function waitUntil(predicate, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(100)
  }
  return predicate()
}

// SIGTERM the owned group, wait a bounded time, then SIGKILL, and fail if it survives.
async function reapGroup(pid) {
  if (!groupAlive(pid)) return
  process.kill(-pid, 'SIGTERM')
  if (await waitUntil(() => !groupAlive(pid), 10_000)) return
  process.kill(-pid, 'SIGKILL')
  if (!(await waitUntil(() => !groupAlive(pid), 5_000)))
    throw new Error(`process group ${pid} survived SIGKILL`)
}

// Owned children run in their own process group, so a terminal interrupt reaches
// only this script, which then reaps them explicitly.
const reaping = []
function run(command, args) {
  controller.signal.throwIfAborted()
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: web, stdio: 'inherit', detached: true })
    const stop = () => reaping.push(reapGroup(child.pid))
    controller.signal.addEventListener('abort', stop, { once: true })
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      controller.signal.removeEventListener('abort', stop)
      if (code === 0) ok()
      else fail(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}`))
    })
  })
}

const redirectBefore = await readIfPresent(redirect)
const productionBefore = await digestTree(production)
await rm(fixture, { recursive: true, force: true })
await mkdir(dirname(fixture), { recursive: true })

let failure
try {
  await run('bun', ['../../scripts/sync-assets.mjs'])
  await run('bun', ['run', 'vite', 'build', '--config', 'vite.auth-fixture.config.ts'])
  controller.signal.throwIfAborted()
  if ((await findFixtureMarkers(fixture)).length === 0)
    throw new Error(`fixture build at ${fixture} carries no fixture markers`)
} catch (error) {
  failure = controller.signal.aborted ? controller.signal.reason : error
} finally {
  // Every owned group must be gone before the redirect is restored.
  const reapFailures = (await Promise.allSettled(reaping)).filter((r) => r.status === 'rejected')
  if (reapFailures.length > 0) failure ??= reapFailures[0].reason
  if (redirectBefore === null) await rm(redirect, { force: true })
  else await writeFile(redirect, redirectBefore)
}

const redirectAfter = await readIfPresent(redirect)
const productionAfter = await digestTree(production)
const productionUnchanged =
  productionBefore.size === productionAfter.size &&
  [...productionBefore].every(([path, digest]) => productionAfter.get(path) === digest)
const redirectRestored =
  redirectBefore === null
    ? redirectAfter === null
    : redirectAfter !== null && Buffer.compare(redirectBefore, redirectAfter) === 0

console.log(JSON.stringify({ fixture, productionUnchanged, redirectRestored }))
if (failure) throw failure
if (!productionUnchanged) throw new Error('the fixture build changed the production output')
if (!redirectRestored)
  throw new Error('the deploy redirect was not restored after the fixture build')
