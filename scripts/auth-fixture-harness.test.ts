import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The fixture acceptance must refuse a missing, malformed or marker-free fixture
// output before it starts any process, and must exit promptly rather than hang.
// These cases never reach PostgreSQL; the port is only a syntactic placeholder.
const harness = fileURLToPath(
  new URL('../apps/web/start/test-auth-fixture-worker.mjs', import.meta.url)
)
const productionDist = fileURLToPath(new URL('../apps/web/dist', import.meta.url))

async function runHarness(fixtureDist: string) {
  const started = Date.now()
  const result = spawnSync('node', [harness], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ADEA_AUTH_WORKER_POSTGRES_PORT: '55433',
      ADEA_AUTH_FIXTURE_DIST: fixtureDist,
    },
    timeout: 30_000,
  })
  return { ...result, elapsed: Date.now() - started }
}

test('a missing fixture output is refused before any process starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-fixture-missing-'))
  try {
    const result = await runHarness(join(directory, 'absent'))

    expect(result.status).not.toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('fixture output is missing')
    expect(result.stderr).toContain('start:build:auth-fixture')
    expect(result.elapsed).toBeLessThan(15_000)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('a malformed fixture wrangler.json is refused before any process starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-fixture-malformed-'))
  try {
    await mkdir(join(directory, 'server'), { recursive: true })
    await writeFile(join(directory, 'server', 'wrangler.json'), '{"main": ')
    const result = await runHarness(directory)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('is malformed')
    expect(result.elapsed).toBeLessThan(15_000)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('an incomplete fixture wrangler.json is refused as malformed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-fixture-incomplete-'))
  try {
    await mkdir(join(directory, 'server'), { recursive: true })
    await writeFile(join(directory, 'server', 'wrangler.json'), '{"main":"index.js"}')
    const result = await runHarness(directory)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('fixture output is malformed')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('an ordinary build without fixture markers is refused, never run as the fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auth-fixture-ordinary-'))
  try {
    await mkdir(join(directory, 'server'), { recursive: true })
    await writeFile(
      join(directory, 'server', 'wrangler.json'),
      JSON.stringify({
        main: 'index.js',
        compatibility_date: '2026-01-01',
        assets: { directory: 'client' },
      })
    )
    await writeFile(join(directory, 'server', 'index.js'), 'export default {}')
    const result = await runHarness(directory)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('carries no fixture markers')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('the production output is never accepted as the fixture output', async () => {
  const result = await runHarness(productionDist)

  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain(
    'refusing to run the fixture acceptance against the production output'
  )
})
