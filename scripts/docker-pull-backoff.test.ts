import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'
import {
  captureCommand,
  composeImageVariable,
  composePostgresImage,
  defaultPullBackoffMs,
  ensureImage,
  fallbackImages,
  isRegistryRateLimit,
  runWithPullBackoff,
  runWithPullFallback,
  withComposeImage,
} from './docker-pull-backoff.mjs'

// Verbatim signature from the failed Host CI compose pull.
const rateLimited = { status: 1, stdout: '', stderr: 'postgres toomanyrequests: Rate exceeded' }
const succeeded = { status: 0, stdout: 'Container postgres Healthy', stderr: '' }
const permanent = { status: 1, stdout: '', stderr: 'manifest unknown' }
const ecrDataLimit = {
  status: 1,
  stdout: '',
  stderr: 'postgres Error toomanyrequests: Data limit exceeded',
}
const canonicalImage =
  'public.ecr.aws/docker/library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2'
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const integrationRunner = fileURLToPath(new URL('./test-integration.mjs', import.meta.url))
const e2eSetup = fileURLToPath(new URL('./e2e-setup.mjs', import.meta.url))
const testLocal = fileURLToPath(new URL('../apps/web/start/test-local.mjs', import.meta.url))

type Result = { status: number | null; stdout?: string; stderr?: string; error?: Error }

// Each call returns the next scripted result; the last one repeats.
function scripted(results: Result[]) {
  const calls: number[] = []
  const attempt = () => {
    calls.push(calls.length)
    return results[Math.min(calls.length - 1, results.length - 1)]
  }
  return { attempt, calls }
}

function recordingSleep() {
  const delays: number[] = []
  return { delays, sleep: async (milliseconds: number) => void delays.push(milliseconds) }
}

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'adea-pull-backoff-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// A stand-in `docker` executable that runs `body` on every call.
async function writeDockerStub(dir: string, body: string) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'docker')
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

test('retries a transient 429 and returns the eventual success', async () => {
  const { attempt, calls } = scripted([rateLimited, succeeded])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, succeeded)
  assert.equal(calls.length, 2)
  assert.deepEqual(delays, [defaultPullBackoffMs[0]])
})

test('awaits an asynchronous attempt before judging its result', async () => {
  const { attempt, calls } = scripted([rateLimited, succeeded])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(async () => attempt(), { sleep, log: () => {} })
  assert.equal(result, succeeded)
  assert.equal(calls.length, 2)
  assert.deepEqual(delays, [defaultPullBackoffMs[0]])
})

test('returns a permanent error on the first attempt without delay', async () => {
  const { attempt, calls } = scripted([permanent])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, permanent)
  assert.equal(calls.length, 1)
  assert.deepEqual(delays, [])
})

test('bounds persistent 429s and surfaces the last rate-limit result', async () => {
  const { attempt, calls } = scripted([rateLimited])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, rateLimited)
  assert.equal(calls.length, defaultPullBackoffMs.length + 1)
  assert.deepEqual(delays, defaultPullBackoffMs)
})

test('recognizes only the registry rate-limit signature', () => {
  assert.equal(isRegistryRateLimit(rateLimited.stderr), true)
  assert.equal(isRegistryRateLimit('429 Too Many Requests'), true)
  assert.equal(isRegistryRateLimit('manifest unknown'), false)
  assert.equal(isRegistryRateLimit(''), false)
})

test('captures a real child output and exit status', async () => {
  const result = await captureCommand(process.execPath, [
    '-e',
    "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
  ])
  assert.equal(result.status, 3)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.equal(result.error, undefined)
})

test('reports a spawn failure as a result instead of rejecting', async () => {
  const result = await captureCommand('/nonexistent/adea-docker-missing', [])
  assert.equal(result.error?.code, 'ENOENT')
  assert.notEqual(result.status, 0)
})

test('retries a real rate-limited child to eventual success', async () => {
  await withTempDir(async (dir) => {
    // First run prints the registry rejection; later runs succeed.
    const flag = join(dir, 'pulled')
    const script =
      "const fs = require('node:fs'); if (fs.existsSync(process.env.FLAG)) process.exit(0); " +
      "fs.writeFileSync(process.env.FLAG, ''); " +
      "console.error('postgres toomanyrequests: Rate exceeded'); process.exit(1)"
    const { delays, sleep } = recordingSleep()
    const result = await runWithPullBackoff(
      () =>
        captureCommand(process.execPath, ['-e', script], {
          env: { ...process.env, FLAG: flag },
        }),
      { sleep, log: () => {} }
    )
    assert.equal(result.status, 0)
    assert.deepEqual(delays, [defaultPullBackoffMs[0]])
  })
})

test('returns a real permanent child failure without retrying', async () => {
  await withTempDir(async (dir) => {
    const calls = join(dir, 'calls')
    const script =
      "require('node:fs').appendFileSync(process.env.CALLS, 'x'); " +
      "console.error('manifest unknown'); process.exit(1)"
    const { delays, sleep } = recordingSleep()
    const result = await runWithPullBackoff(
      () =>
        captureCommand(process.execPath, ['-e', script], {
          env: { ...process.env, CALLS: calls },
        }),
      { sleep, log: () => {} }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /manifest unknown/)
    assert.equal(await readFile(calls, 'utf8'), 'x')
    assert.deepEqual(delays, [])
  })
})

test('every Postgres entrypoint starts the database through the pull-fallback helper', async () => {
  for (const path of [testLocal, e2eSetup, integrationRunner]) {
    const source = await readFile(path, 'utf8')
    assert.match(
      source,
      /import \{[^}]*\brunWithPullFallback\b[^}]*\} from '[\w./-]*docker-pull-backoff\.mjs'/,
      path
    )
    assert.match(source, /await runWithPullFallback\(/, path)
    assert.match(source, /await composeUpPostgres\(\)/, path)
    // A bare `up` through run() would bypass the fallback and the backoff.
    assert.doesNotMatch(source, /run\(\s*'docker',\s*\[[^\]]*'up'/, path)
  }
})

test('compose.yml takes the Postgres image from the override with a digest-pinned default', async () => {
  const image = composePostgresImage(repositoryRoot)
  assert.match(image, /^public\.ecr\.aws\/docker\/library\/postgres:[\w.-]+@sha256:[0-9a-f]{64}$/)
  const compose = await readFile(join(repositoryRoot, 'compose.yml'), 'utf8')
  assert.ok(compose.includes(`\${${composeImageVariable}:-${image}}`))
})

test('derives the same digest on the fallback registries and none for other images', () => {
  assert.deepEqual(fallbackImages(canonicalImage), [
    'mirror.gcr.io/library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2',
    'docker.io/library/postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2',
  ])
  assert.deepEqual(fallbackImages('mcr.microsoft.com/playwright:v1.63.0-noble'), [])
})

test('selects a fallback image only when one is given', () => {
  const env = { PATH: '/bin' }
  assert.equal(withComposeImage(env, undefined), env)
  assert.deepEqual(withComposeImage(env, 'mirror.gcr.io/library/postgres:18-alpine'), {
    PATH: '/bin',
    [composeImageVariable]: 'mirror.gcr.io/library/postgres:18-alpine',
  })
})

function fallbackHarness(attempts: Record<string, Result[]>, pulls: Record<string, Result> = {}) {
  const attempted: (string | undefined)[] = []
  const pulled: string[] = []
  const messages: string[] = []
  const { delays, sleep } = recordingSleep()
  const counts: Record<string, number> = {}
  return {
    attempted,
    pulled,
    messages,
    delays,
    run: () =>
      runWithPullFallback(
        (image) => {
          attempted.push(image)
          const key = image ?? 'canonical'
          const results = attempts[key] ?? [ecrDataLimit]
          counts[key] = (counts[key] ?? 0) + 1
          return results[Math.min(counts[key] - 1, results.length - 1)]
        },
        canonicalImage,
        {
          sleep,
          log: (message: string) => messages.push(message),
          pull: async (reference: string) => {
            pulled.push(reference)
            return pulls[reference] ?? { status: 0, stdout: '', stderr: '' }
          },
        }
      ),
  }
}

const mirror = fallbackImages(canonicalImage)[0]!
const hub = fallbackImages(canonicalImage)[1]!

test('does not touch another registry when the canonical pull succeeds', async () => {
  const harness = fallbackHarness({ canonical: [succeeded] })
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined])
  assert.deepEqual(harness.pulled, [])
})

test('returns a permanent canonical failure without trying a fallback', async () => {
  const harness = fallbackHarness({ canonical: [permanent] })
  assert.equal(await harness.run(), permanent)
  assert.deepEqual(harness.pulled, [])
  assert.deepEqual(harness.delays, [])
})

test('falls over to the mirror registry on a rate limit, without backing off', async () => {
  const harness = fallbackHarness({ canonical: [ecrDataLimit], [mirror]: [succeeded] })
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined, mirror])
  assert.deepEqual(harness.pulled, [mirror])
  assert.deepEqual(harness.delays, [])
})

test('skips a fallback that cannot be pulled and tries the next one', async () => {
  const harness = fallbackHarness(
    { canonical: [ecrDataLimit], [hub]: [succeeded] },
    { [mirror]: { status: 1, stdout: '', stderr: 'manifest unknown' } }
  )
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined, hub])
  assert.deepEqual(harness.pulled, [mirror, hub])
  assert.ok(harness.messages.some((message) => /manifest unknown/.test(message)))
})

test('returns a real failure from a fallback instead of masking it', async () => {
  const harness = fallbackHarness({ canonical: [ecrDataLimit], [mirror]: [permanent] })
  assert.equal(await harness.run(), permanent)
  assert.deepEqual(harness.pulled, [mirror])
})

test('backs off and retries every registry when all of them are rate limited', async () => {
  const harness = fallbackHarness({ canonical: [ecrDataLimit, ecrDataLimit, succeeded] })
  assert.equal(await harness.run(), succeeded)
  assert.deepEqual(harness.attempted, [undefined, mirror, hub, undefined, mirror, hub, undefined])
  assert.deepEqual(harness.delays, defaultPullBackoffMs.slice(0, 2))
})

test('bounds persistent rate limits across every registry', async () => {
  const harness = fallbackHarness({})
  assert.equal(await harness.run(), ecrDataLimit)
  assert.equal(harness.attempted.length, 3 * (defaultPullBackoffMs.length + 1))
  assert.deepEqual(harness.delays, defaultPullBackoffMs)
})

test('ensures an image without pulling when it is already local', async () => {
  const pulled: string[] = []
  const found = await ensureImage(canonicalImage, {
    inspect: async () => ({ status: 0 }),
    pull: async (reference: string) => (pulled.push(reference), succeeded),
    log: () => {},
  })
  assert.equal(found.image, canonicalImage)
  assert.equal(found.result.status, 0)
  assert.deepEqual(pulled, [])
})

test('ensures an image from a fallback registry and reports the reference now local', async () => {
  const pulled: string[] = []
  const { sleep } = recordingSleep()
  const found = await ensureImage(canonicalImage, {
    inspect: async () => ({ status: 1 }),
    pull: async (reference: string) => {
      pulled.push(reference)
      return reference === canonicalImage ? ecrDataLimit : succeeded
    },
    sleep,
    log: () => {},
  })
  assert.equal(found.result.status, 0)
  assert.equal(found.image, mirror)
  assert.deepEqual(pulled, [canonicalImage, mirror])
})

test('reports an image that no registry could provide', async () => {
  const { sleep } = recordingSleep()
  const found = await ensureImage(canonicalImage, {
    inspect: async () => ({ status: 1 }),
    pull: async () => ecrDataLimit,
    sleep,
    log: () => {},
  })
  assert.notEqual(found.result.status, 0)
})

test('e2e setup surfaces a permanent docker failure once, with its output', async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, 'bin')
    const calls = join(dir, 'calls')
    await writeDockerStub(
      bin,
      'echo call >> "$CALLS"\necho "Error response from daemon: manifest unknown" >&2\nexit 1'
    )
    const result = spawnSync(process.execPath, [e2eSetup], {
      encoding: 'utf8',
      env: { PATH: bin, CALLS: calls },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Error response from daemon: manifest unknown/)
    assert.match(
      result.stderr,
      /docker compose up -d --wait --wait-timeout 60 postgres failed with exit code 1/
    )
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1)
  })
})

test('e2e setup surfaces a missing docker executable as a spawn error', async () => {
  await withTempDir(async (dir) => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    const result = spawnSync(process.execPath, [e2eSetup], {
      encoding: 'utf8',
      env: { PATH: empty },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ENOENT/)
  })
})
