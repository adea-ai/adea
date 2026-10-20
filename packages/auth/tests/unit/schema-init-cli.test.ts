import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

// The operator entry the Railway cutover checklist names. Each test runs the real
// CLI as a child process with a fixed, minimal environment. None reaches a database:
// the connection tests point at ports that refuse connections at once, and the
// runtime URL points at a listener that counts any connection made to it.

const CLI = resolve(import.meta.dir, '../../src/schema-init-cli.ts')
const MIGRATION_PASSWORD = 'owner-only-cli-contract-password'
const base = {
  AUTH_BASE_URL: 'https://auth.example.test',
  AUTH_SECRET: 'unit-cli-contract-secret-at-least-thirty-two-characters',
  AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
}

// A child is killed at its own deadline. The test's deadline is longer than the child's
// deadline plus its kill-and-reap, so a stalled child always ends before its test does.
const CHILD_DEADLINE_MS = 20_000
const TEST_TIMEOUT_MS = 30_000

type ChildResult = {
  code: number
  pid: number
  stderr: string
  stdout: string
  timedOut: boolean
}

/** Runs a command under a deadline. The child is killed and reaped on every exit path. */
async function runChild(
  command: string[],
  environment: Record<string, string>,
  deadlineMs = CHILD_DEADLINE_MS
): Promise<ChildResult> {
  const child = Bun.spawn(command, { env: environment, stderr: 'pipe', stdout: 'pipe' })
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, deadlineMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const code = await child.exited
    return { code, pid: child.pid, stderr, stdout, timedOut }
  } finally {
    clearTimeout(killer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await child.exited.catch(() => undefined)
  }
}

async function run(args: string[], environment: Record<string, string>): Promise<ChildResult> {
  const result = await runChild([process.execPath, '--no-env-file', CLI, ...args], {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...environment,
  })
  if (result.timedOut) {
    throw new Error(`schema-init exceeded ${CHILD_DEADLINE_MS} ms and was killed`)
  }
  return result
}

/**
 * A loopback port that refuses connections. It is chosen while every listener in
 * `held` is still open, so it can never be the port one of them holds.
 */
function refusedPort(held: readonly { port: number }[]): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  if (held.some((other) => other.port === port)) {
    throw new Error('a refused port collided with a held listener')
  }
  return port
}

function singleLineJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trim()) as Record<string, unknown>
}

describe('the schema-init operator entry', () => {
  test(
    'refuses an unknown flag with the usage line, and changes nothing',
    async () => {
      const result = await run(['--force'], base)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('usage: schema-init [--plan | --apply]')
      expect(result.stdout).toBe('')
    },
    TEST_TIMEOUT_MS
  )

  test(
    'refuses --plan and --apply together, so nothing runs by accident',
    async () => {
      const result = await run(['--plan', '--apply'], base)
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('usage: schema-init')
      expect(result.stdout).toBe('')
    },
    TEST_TIMEOUT_MS
  )

  test(
    'plan fails at config without a migration URL, and an apply does the same',
    async () => {
      const plan = await run([], base)
      expect(plan.code).toBe(1)
      expect(singleLineJson(plan.stderr)).toEqual({
        message: 'AUTH_MIGRATION_DATABASE_URL is required',
        mode: 'plan',
        stage: 'config',
        status: 'failed',
      })

      const apply = await run(['--apply'], base)
      expect(apply.code).toBe(1)
      expect(singleLineJson(apply.stderr)).toMatchObject({ mode: 'apply', stage: 'config' })
    },
    TEST_TIMEOUT_MS
  )

  test(
    'the runtime URL alone is not enough for either mode',
    async () => {
      const runtimeOnly = {
        ...base,
        AUTH_DATABASE_URL: `postgresql://runtime_app:runtime-only-password@127.0.0.1:${refusedPort([])}/adea`,
      }
      for (const args of [[], ['--apply']]) {
        const result = await run(args, runtimeOnly)
        expect(result.code).toBe(1)
        expect(singleLineJson(result.stderr)).toMatchObject({ stage: 'config' })
      }
    },
    TEST_TIMEOUT_MS
  )

  test(
    'plan connects to the migration URL and never makes a connection to the runtime URL',
    async () => {
      let runtimeConnections = 0
      // Every connection to this listener is counted, so a stray runtime connection
      // would be observed, not inferred from the error text.
      const runtime = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
          data() {},
          open(socket) {
            runtimeConnections += 1
            socket.end()
          },
        },
      })
      try {
        const migrationPort = refusedPort([runtime])
        const result = await run([], {
          ...base,
          AUTH_DATABASE_URL: `postgresql://runtime_app:runtime-only-password@127.0.0.1:${runtime.port}/adea`,
          AUTH_MIGRATION_DATABASE_URL: `postgresql://auth_owner:${MIGRATION_PASSWORD}@127.0.0.1:${migrationPort}/adea`,
        })
        expect(result.code).toBe(1)
        const failure = singleLineJson(result.stderr)
        expect(failure).toMatchObject({ mode: 'plan', stage: 'connect', status: 'failed' })
        expect(String(failure.message)).toContain(`:${migrationPort}`)
        expect(runtimeConnections).toBe(0)
      } finally {
        runtime.stop(true)
      }
    },
    TEST_TIMEOUT_MS
  )

  test(
    'a failure never prints the migration password',
    async () => {
      const result = await run(['--apply'], {
        ...base,
        AUTH_MIGRATION_DATABASE_URL: `postgresql://auth_owner:${MIGRATION_PASSWORD}@127.0.0.1:${refusedPort([])}/adea`,
      })
      expect(result.code).toBe(1)
      expect(result.stdout + result.stderr).not.toContain(MIGRATION_PASSWORD)
    },
    TEST_TIMEOUT_MS
  )

  test(
    'a stalled child is killed at its deadline and reaped on the same path the CLI uses',
    async () => {
      const result = await runChild(['sleep', '30'], { PATH: process.env.PATH ?? '' }, 200)
      expect(result.timedOut).toBe(true)
      expect(() => process.kill(result.pid, 0)).toThrow()
    },
    TEST_TIMEOUT_MS
  )
})
