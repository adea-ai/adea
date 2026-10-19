import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// The fixture build rewrites the shared Cloudflare deploy redirect. An interrupted
// build must stop its owned build and put the original redirect back byte-for-byte.
// The interrupt is sent only after the fixture build has rewritten the redirect, so
// the restore is what this test proves.
const web = fileURLToPath(new URL('../apps/web', import.meta.url))
const redirect = `${web}/.wrangler/deploy/config.json`
const builder = `${web}/start/build-auth-fixture.mjs`

async function readRedirect(): Promise<Buffer | null> {
  try {
    return await readFile(redirect)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

test('an interrupted fixture build stops its owned build and restores the deploy redirect', async () => {
  const before = await readRedirect()
  const child = spawn('node', [builder], { cwd: web, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const exited = new Promise<{ code: number | null; signal: string | null }>((ok) =>
    child.once('exit', (code, signal) => ok({ code, signal }))
  )

  let rewritten = false
  for (let attempt = 0; attempt < 1200 && !rewritten; attempt += 1) {
    const current = await readRedirect()
    rewritten = current !== null && current.toString().includes('auth-fixture')
    if (!rewritten) await delay(100)
  }
  if (!rewritten) {
    child.kill('SIGKILL')
    throw new Error('the fixture build never rewrote the deploy redirect; nothing to interrupt')
  }

  child.kill('SIGINT')
  const result = await Promise.race([
    exited,
    delay(180_000).then(() => {
      child.kill('SIGKILL')
      throw new Error('the interrupted fixture build did not exit')
    }),
  ])

  expect(result.code).not.toBe(0)
  expect(output).toContain('interrupted by SIGINT')
  const after = await readRedirect()
  expect(after?.toString('base64') ?? null).toBe(before?.toString('base64') ?? null)
}, 240_000)
