import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

// The operator entry the Railway cutover checklist names. Each test runs the real
// CLI as a child process with a fixed, minimal environment. None reaches a database:
// the connection tests point at ports that refuse connections at once.
const CLI = resolve(import.meta.dir, '../../src/schema-init-cli.ts')
const MIGRATION_PASSWORD = 'owner-only-cli-contract-password'
const base = {
  AUTH_BASE_URL: 'https://auth.example.test',
  AUTH_SECRET: 'unit-cli-contract-secret-at-least-thirty-two-characters',
  AUTH_TRUSTED_ORIGINS: 'https://app.example.test',
}

/** A loopback port that was free a moment ago, so a connection to it is refused. */
async function refusedPort(): Promise<number> {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

async function run(args: string[], environment: Record<string, string>) {
  const child = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...environment },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  // A stalled child is killed, so a failing test cannot hang the lane.
  const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code: await child.exited, stderr, stdout }
  } finally {
    clearTimeout(killer)
  }
}

function singleLineJson(text: string): Record<string, unknown> {
  return JSON.parse(text.trim()) as Record<string, unknown>
}

describe('the schema-init operator entry', () => {
  test('refuses an unknown flag with the usage line, and changes nothing', async () => {
    const result = await run(['--force'], base)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('usage: schema-init [--plan | --apply]')
    expect(result.stdout).toBe('')
  })

  test('refuses --plan and --apply together, so nothing runs by accident', async () => {
    const result = await run(['--plan', '--apply'], base)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('usage: schema-init')
    expect(result.stdout).toBe('')
  })

  test('plan fails at config without a migration URL, and an apply does the same', async () => {
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
  })

  test('the runtime URL alone is not enough for either mode', async () => {
    const runtimeOnly = {
      ...base,
      AUTH_DATABASE_URL: `postgresql://runtime_app:runtime-only-password@127.0.0.1:${await refusedPort()}/adea`,
    }
    for (const args of [[], ['--apply']]) {
      const result = await run(args, runtimeOnly)
      expect(result.code).toBe(1)
      expect(singleLineJson(result.stderr)).toMatchObject({ stage: 'config' })
    }
  })

  test('plan connects to the migration URL and never to the runtime URL', async () => {
    const runtimePort = await refusedPort()
    const migrationPort = await refusedPort()
    const result = await run([], {
      ...base,
      AUTH_DATABASE_URL: `postgresql://runtime_app:runtime-only-password@127.0.0.1:${runtimePort}/adea`,
      AUTH_MIGRATION_DATABASE_URL: `postgresql://auth_owner:${MIGRATION_PASSWORD}@127.0.0.1:${migrationPort}/adea`,
    })
    expect(result.code).toBe(1)
    const failure = singleLineJson(result.stderr)
    expect(failure).toMatchObject({ mode: 'plan', stage: 'connect', status: 'failed' })
    expect(String(failure.message)).toContain(`:${migrationPort}`)
    expect(String(failure.message)).not.toContain(`:${runtimePort}`)
  })

  test('a failure never prints the migration password', async () => {
    const result = await run(['--apply'], {
      ...base,
      AUTH_MIGRATION_DATABASE_URL: `postgresql://auth_owner:${MIGRATION_PASSWORD}@127.0.0.1:${await refusedPort()}/adea`,
    })
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).not.toContain(MIGRATION_PASSWORD)
  })
})
