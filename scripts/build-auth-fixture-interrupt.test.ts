import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// The fixture builder rewrites a shared Cloudflare redirect, so this test never runs
// the real build or touches the checkout. It builds a disposable workspace with a copy
// of the builder and a stub Vite that writes the redirect the way the plugin does, then
// holds at that boundary. The test interrupts the builder there and checks that it stops
// the stub's process group and restores the original redirect bytes. Every process the
// test starts is reaped in finally, even when an assertion or a timeout fails.
const repo = fileURLToPath(new URL('..', import.meta.url))
const webSource = resolve(repo, 'apps/web')

function groupOf(pid: number): number | undefined {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
  const pgid = Number(result.stdout.trim())
  return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null }

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// Stub Vite: writes the redirect as a real build does, records its pid, then holds.
const stubVite = `import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const web = process.cwd()
mkdirSync(resolve(web, '.wrangler/deploy'), { recursive: true })
writeFileSync(
  resolve(web, '.wrangler/deploy/config.json'),
  JSON.stringify({ configPath: '../../start/.checks/auth-fixture/dist/server/wrangler.json', auxiliaryWorkers: [] })
)
writeFileSync(resolve(web, 'ready'), String(process.pid))
setInterval(() => {}, 1_000)
`

test('an interrupted fixture build stops its owned group and restores the redirect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixture-builder-interrupt-'))
  const web = join(root, 'apps', 'web')
  const ready = join(web, 'ready')
  const redirect = join(web, '.wrangler/deploy/config.json')
  const original = Buffer.from(
    JSON.stringify({ configPath: '../../dist/server/wrangler.json', auxiliaryWorkers: [] })
  )
  let builder: ReturnType<typeof spawn> | undefined
  let stubGroup: number | undefined
  let output = ''
  try {
    await mkdir(join(web, 'start'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await mkdir(join(web, 'node_modules/.bin'), { recursive: true })
    await mkdir(join(web, 'dist'), { recursive: true })
    await copyFile(
      join(webSource, 'start/build-auth-fixture.mjs'),
      join(web, 'start/build-auth-fixture.mjs')
    )
    await copyFile(
      join(webSource, 'start/auth-fixture-markers.mjs'),
      join(web, 'start/auth-fixture-markers.mjs')
    )
    await writeFile(join(root, 'scripts/sync-assets.mjs'), 'export {}\n')
    await writeFile(join(web, 'dist/index.html'), '<!doctype html>\n')
    // \`bun run vite\` resolves the workspace's node_modules/.bin, as the production build does.
    await writeFile(join(web, 'node_modules/.bin/vite'), `#!/usr/bin/env node\n${stubVite}`)
    await chmod(join(web, 'node_modules/.bin/vite'), 0o755)
    await writeFile(join(web, 'vite.auth-fixture.config.ts'), 'export default {}\n')
    await mkdir(join(web, '.wrangler/deploy'), { recursive: true })
    await writeFile(redirect, original)

    builder = spawn('node', [join(web, 'start/build-auth-fixture.mjs')], {
      cwd: web,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    builder.stdout?.on('data', (chunk) => (output += chunk))
    builder.stderr?.on('data', (chunk) => (output += chunk))
    const exited = new Promise<Exit>((ok) =>
      builder!.once('exit', (code, signal) => ok({ code, signal }))
    )

    // Hold until the stub reaches the rewrite boundary. An early builder exit ends the wait at once.
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if ((await readOrNull(ready)) !== null) break
      const early = await Promise.race([exited, delay(50).then(() => undefined)])
      if (early) throw new Error(`the builder exited before the redirect was rewritten: ${output}`)
    }
    const stubPid = Number((await readOrNull(ready))?.toString())
    if (!Number.isInteger(stubPid)) throw new Error('the stub never reached the rewrite boundary')
    stubGroup = groupOf(stubPid)
    // Successful process-group discovery is required; an undefined group would make the check vacuous.
    if (stubGroup === undefined)
      throw new Error(`could not discover the process group of stub ${stubPid}`)
    expect((await readFile(redirect)).toString()).toContain('auth-fixture')

    builder.kill('SIGINT')
    // The watchdog is cancelled as soon as the builder exits, so no timer outlives the test.
    const watchdog = new AbortController()
    const result = await Promise.race([
      exited,
      delay(60_000, undefined, { signal: watchdog.signal }).then(() => {
        throw new Error('the interrupted builder did not exit within 60 s')
      }),
    ])
    watchdog.abort()
    expect(result.code).not.toBe(0)
    expect(output).toContain('interrupted by SIGINT')
    expect(groupAlive(stubGroup)).toBe(false)
    expect((await readOrNull(redirect))?.equals(original)).toBe(true)
  } finally {
    // Every owned process is stopped and confirmed gone before the disposable workspace is deleted.
    if (builder && builder.exitCode === null && builder.signalCode === null) {
      builder.kill('SIGKILL')
      await new Promise<void>((ok) => {
        if (builder!.exitCode !== null || builder!.signalCode !== null) return ok()
        builder!.once('exit', () => ok())
      })
    }
    if (stubGroup !== undefined) {
      try {
        process.kill(-stubGroup, 'SIGKILL')
      } catch {}
      for (let attempt = 0; attempt < 50 && groupAlive(stubGroup); attempt += 1) await delay(100)
    }
    await rm(root, { recursive: true, force: true })
  }
}, 240_000)
