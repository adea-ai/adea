// Builds the auth fixture: the app build with the loopback recording transport in
// place of the production module, written to start/.checks/auth-fixture/dist. The
// production dist/ is never written. Every Vite build of this app rewrites the
// Cloudflare deploy redirect (.wrangler/deploy/config.json) to its own output, so
// the redirect is restored byte-for-byte afterwards and an ordinary deploy still
// resolves to the production output.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFixtureMarkers } from './auth-fixture-markers.mjs'

const start = dirname(fileURLToPath(import.meta.url))
const web = resolve(start, '..')
const production = resolve(web, 'dist')
const fixture = resolve(start, '.checks/auth-fixture/dist')
const redirect = resolve(web, '.wrangler/deploy/config.json')

async function digestTree(directory) {
  const digests = new Map()
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
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

function run(command, args) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: web, stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`${command} ${args.join(' ')} exited ${code}`))
    )
  })
}

const redirectBefore = await readFile(redirect).catch(() => null)
const productionBefore = await digestTree(production)
await rm(fixture, { recursive: true, force: true })
await mkdir(dirname(fixture), { recursive: true })

let failure
try {
  await run('bun', ['../../scripts/sync-assets.mjs'])
  await run('bun', ['x', 'vite', 'build', '--config', 'vite.auth-fixture.config.ts'])
  if ((await findFixtureMarkers(fixture)).length === 0)
    throw new Error(`fixture build at ${fixture} carries no fixture markers`)
} catch (error) {
  failure = error
} finally {
  if (redirectBefore === null) await rm(redirect, { force: true })
  else await writeFile(redirect, redirectBefore)
}

const redirectAfter = await readFile(redirect).catch(() => null)
const productionAfter = await digestTree(production)
const productionUnchanged =
  productionBefore.size === productionAfter.size &&
  [...productionBefore].every(([path, digest]) => productionAfter.get(path) === digest)
const redirectRestored =
  redirectBefore === null
    ? redirectAfter === null
    : Buffer.compare(redirectBefore, redirectAfter) === 0

const report = { fixture, productionUnchanged, redirectRestored }
console.log(JSON.stringify(report))
if (failure) throw failure
if (!productionUnchanged) throw new Error('the fixture build changed the production output')
if (!redirectRestored)
  throw new Error('the deploy redirect was not restored after the fixture build')
