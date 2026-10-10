import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'bun:test'
import {
  defaultPullBackoffMs,
  isRegistryRateLimit,
  runWithPullBackoff,
} from '../start/docker-pull-backoff.mjs'

// Verbatim signature from the failed Host CI compose pull.
const rateLimited = { status: 1, stdout: '', stderr: 'postgres toomanyrequests: Rate exceeded' }
const succeeded = { status: 0, stdout: 'Container postgres Healthy', stderr: '' }

function scripted(results: { status: number; stdout: string; stderr: string }[]) {
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

test('retries a transient 429 and returns the eventual success', async () => {
  const { attempt, calls } = scripted([rateLimited, succeeded])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, succeeded)
  assert.equal(calls.length, 2)
  assert.deepEqual(delays, [defaultPullBackoffMs[0]])
})

test('returns a permanent error on the first attempt without delay', async () => {
  const failure = { status: 1, stdout: '', stderr: 'manifest unknown' }
  const { attempt, calls } = scripted([failure])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, failure)
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

test('the Host local check starts postgres through the pull-backoff path', async () => {
  const source = await readFile(new URL('../start/test-local.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ runWithPullBackoff \} from '\.\/docker-pull-backoff\.mjs'/)
  assert.match(source, /await composeUpPostgres\(\)/)
  // A bare compose-up through run() would bypass the backoff; pin that it is gone.
  assert.doesNotMatch(
    source,
    /run\(\s*'docker',\s*\[\s*'compose',\s*'-p',\s*project,\s*'-f',\s*'compose\.yml',\s*'up'/
  )
})
