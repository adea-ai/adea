/*
 * The self-hosted auth lifecycle qualification.
 *
 * `packages/auth/tests/integration/better-auth-postgres.test.ts` proves the
 * self-hosted Better Auth service against a real PostgreSQL: it migrates an
 * isolated schema, signs a user up, reads the session back, revokes it, and
 * proves the persisted session is gone.
 *
 * The suite skips itself when `AUTH_POSTGRES_TEST_URL` is absent, and a
 * skipped suite is not a proof: it is a green line that says nothing about the
 * lifecycle. This module runs the suite with the URL supplied and refuses a run
 * that skipped, so a missing variable fails the lane instead of passing it.
 *
 * The module is deliberately free of the runners around it, so the integration
 * lane and the disposable PostgreSQL proof can both use it and neither has to
 * grow its own copy of the fail-closed rule.
 */

/** The suite that proves the self-hosted lifecycle against a real database. */
export const SELF_HOSTED_AUTH_LIFECYCLE_TEST =
  'packages/auth/tests/integration/better-auth-postgres.test.ts'

/** The command runner this module needs: one command, its status and its output. */
export type AuthLifecycleCommand = (
  name: string,
  args: readonly string[],
  environment: Record<string, string | undefined>
) => { status: number; stdout: string; stderr: string }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * The URL the suite connects with. It must name a loopback PostgreSQL: the
 * suite creates and drops its own schema, and it must never reach a database
 * that is not disposable.
 */
export function assertLoopbackAuthDatabaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('AUTH_POSTGRES_TEST_URL must be a valid URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('AUTH_POSTGRES_TEST_URL must use the PostgreSQL protocol')
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('AUTH_POSTGRES_TEST_URL must use a loopback host')
  }
  if (!url.username || !url.password) {
    throw new Error('AUTH_POSTGRES_TEST_URL must include a role and a password')
  }
  return url
}

/**
 * The minimal environment the suite runs in: its one URL, and the process
 * settings a test needs to run at all. Nothing else is inherited, so a value
 * in the caller's environment cannot change what the lifecycle proves.
 */
export function selfHostedAuthLifecycleEnvironment(
  databaseUrl: string,
  inherited: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {}
  for (const name of ['PATH', 'TMPDIR', 'LANG']) {
    if (inherited[name]) environment[name] = inherited[name]
  }
  environment.AUTH_POSTGRES_TEST_URL = databaseUrl
  return environment
}

/** Hides a password that a failure message would otherwise carry. */
function redactPassword(output: string, databaseUrl: string): string {
  let password: string
  try {
    password = decodeURIComponent(new URL(databaseUrl).password)
  } catch {
    return output
  }
  if (!password) return output
  return output.replaceAll(password, '***').replaceAll(encodeURIComponent(password), '***')
}

/** The failing lines of a run that did not pass. The header is not one of them. */
function failureEvidence(output: string, databaseUrl: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const failing = lines.filter((line) =>
    /\(fail\)|\(todo\)|error:|assertionerror|expected|received|exception/i.test(line)
  )
  const chosen = (failing.length > 0 ? failing : lines.slice(-5)).slice(0, 20)
  return redactPassword(chosen.join('\n'), databaseUrl).slice(0, 2000)
}

/**
 * Runs the self-hosted auth lifecycle suite against a real loopback database
 * and refuses a run that proved nothing.
 *
 * A run fails when the suite fails, when it skipped a case, and when it
 * reported no passing case at all. The last two are the missing-variable skip
 * that would otherwise read as a pass.
 */
export function proveSelfHostedAuthLifecycle(
  command: AuthLifecycleCommand,
  input: { readonly databaseUrl: string },
  inherited: Record<string, string | undefined> = process.env
): void {
  const databaseUrl = assertLoopbackAuthDatabaseUrl(input.databaseUrl).toString()
  const result = command(
    'bun',
    ['--no-env-file', 'test', '--conditions=react-server', SELF_HOSTED_AUTH_LIFECYCLE_TEST],
    selfHostedAuthLifecycleEnvironment(databaseUrl, inherited)
  )
  const output = `${result.stdout}\n${result.stderr}`
  if (result.status !== 0) {
    const detail = failureEvidence(output, databaseUrl)
    throw new Error(
      `the self-hosted auth lifecycle test failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`
    )
  }
  if (/\b[1-9]\d* skip\b/.test(output)) {
    throw new Error(
      'the self-hosted auth lifecycle test skipped a case; a skipped run is not a proof'
    )
  }
  if (!/\b[1-9]\d* pass\b/.test(output)) {
    throw new Error(
      'the self-hosted auth lifecycle test did not run to completion; a skipped run is not a proof'
    )
  }
}
