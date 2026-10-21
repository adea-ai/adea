import { describe, expect, test } from 'bun:test'

import {
  SELF_HOSTED_AUTH_LIFECYCLE_TEST,
  assertLoopbackAuthDatabaseUrl,
  proveSelfHostedAuthLifecycle,
  selfHostedAuthLifecycleEnvironment,
} from './self-hosted-auth-lifecycle'

const loopbackUrl =
  'postgresql://agent_hq_local_admin:local-admin@127.0.0.1:55432/agent_hq?sslmode=disable'

/** A run that reports what the real Bun runner reports for a passing suite. */
function passingOutput(): string {
  return [
    'bun test v1.4.3',
    '(pass) migrates an isolated schema, persists signup/session, and revokes the session [412.00ms]',
    ' 1 pass',
    ' 0 fail',
    ' 0 skip',
    'Ran 1 test across 1 file. [412.00ms]',
  ].join('\n')
}

/** The output the real Bun runner reports when the suite skipped itself. */
function skippedOutput(): string {
  return [
    'bun test v1.4.3',
    ' 0 pass',
    ' 3 skip',
    ' 0 fail',
    'Ran 3 tests across 1 file. [112.00ms]',
  ].join('\n')
}

describe('the self-hosted auth lifecycle qualification', () => {
  test('it runs the real suite, with the URL supplied and nothing else inherited', () => {
    const calls: {
      name: string
      args: readonly string[]
      env: Record<string, string | undefined>
    }[] = []
    proveSelfHostedAuthLifecycle(
      (name, args, environment) => {
        calls.push({ name, args, env: environment })
        return { status: 0, stdout: passingOutput(), stderr: '' }
      },
      { databaseUrl: loopbackUrl },
      {
        PATH: '/synthetic/bin',
        TMPDIR: '/tmp',
        LANG: 'C',
        DATABASE_URL: 'postgresql://someone:secret@db.example.com/agent_hq',
        AUTH_SECRET: 'untrusted',
      }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('bun')
    expect(calls[0]?.args).toEqual([
      '--no-env-file',
      'test',
      '--conditions=react-server',
      SELF_HOSTED_AUTH_LIFECYCLE_TEST,
    ])
    expect(calls[0]?.env.AUTH_POSTGRES_TEST_URL).toBe(loopbackUrl)
    // Nothing else is inherited: a value in the caller's environment cannot
    // change what the lifecycle proves.
    expect(Object.keys(calls[0]?.env ?? {}).toSorted()).toEqual(
      ['AUTH_POSTGRES_TEST_URL', 'LANG', 'PATH', 'TMPDIR'].toSorted()
    )
  })

  test('a skipped run is refused: the missing-variable skip is not a proof', () => {
    expect(() =>
      proveSelfHostedAuthLifecycle(() => ({ status: 0, stdout: skippedOutput(), stderr: '' }), {
        databaseUrl: loopbackUrl,
      })
    ).toThrow('a skipped run is not a proof')
  })

  test('a run that reported no passing case is refused', () => {
    expect(() =>
      proveSelfHostedAuthLifecycle(
        () => ({ status: 0, stdout: 'bun test v1.4.3\n 0 pass\n 0 fail\n 0 skip\n', stderr: '' }),
        { databaseUrl: loopbackUrl }
      )
    ).toThrow('a skipped run is not a proof')
  })

  test('a failed run is refused and carries the failing lines, not the header', () => {
    expect(() =>
      proveSelfHostedAuthLifecycle(
        () => ({
          status: 1,
          stdout: [
            'bun test v1.4.3',
            '(pass) a passing neighbour [1.00ms]',
            '(fail) migrates an isolated schema, persists signup/session, and revokes the session [3.00ms]',
            'error: expect(received).toBe(expected)',
          ].join('\n'),
          stderr: '',
        }),
        { databaseUrl: loopbackUrl }
      )
    ).toThrow('the self-hosted auth lifecycle test failed with exit code 1')
    expect(() =>
      proveSelfHostedAuthLifecycle(
        () => ({
          status: 1,
          stdout: [
            'bun test v1.4.3',
            '(pass) a passing neighbour [1.00ms]',
            '(fail) migrates an isolated schema, persists signup/session, and revokes the session [3.00ms]',
          ].join('\n'),
          stderr: '',
        }),
        { databaseUrl: loopbackUrl }
      )
    ).toThrow('(fail) migrates an isolated schema')
  })

  test('a failure message never carries the password', () => {
    let message = ''
    try {
      proveSelfHostedAuthLifecycle(
        () => ({
          status: 1,
          stdout:
            'error: connect postgresql://agent_hq_local_admin:local-admin@127.0.0.1:55432/agent_hq failed',
          stderr: '',
        }),
        { databaseUrl: loopbackUrl }
      )
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('agent_hq_local_admin')
    expect(message).not.toContain('local-admin')
  })

  test('a failure with no recognisable failing line still reports something', () => {
    // The header alone is not a diagnosis, but an empty report is worse than a
    // short one: the last lines are carried when no line looks like a failure.
    let message = ''
    try {
      proveSelfHostedAuthLifecycle(
        () => ({
          status: 1,
          stdout: ['bun test v1.4.3', 'a plain line', 'another plain line'].join('\n'),
          stderr: '',
        }),
        { databaseUrl: loopbackUrl }
      )
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('another plain line')
    expect(message).toContain('exit code 1')
  })

  test('only a loopback database may be used', () => {
    for (const url of [
      'postgresql://agent_hq_local_admin:local-admin@db.example.com:5432/agent_hq?sslmode=require',
      'postgresql://agent_hq_local_admin:local-admin@10.0.0.5:5432/agent_hq?sslmode=disable',
    ]) {
      expect(() => assertLoopbackAuthDatabaseUrl(url)).toThrow('must use a loopback host')
      expect(() =>
        proveSelfHostedAuthLifecycle(() => ({ status: 0, stdout: passingOutput(), stderr: '' }), {
          databaseUrl: url,
        })
      ).toThrow('must use a loopback host')
    }
  })

  test('the URL must be a PostgreSQL URL with a role and a password', () => {
    expect(() => assertLoopbackAuthDatabaseUrl('not a url')).toThrow('must be a valid URL')
    expect(() => assertLoopbackAuthDatabaseUrl('https://127.0.0.1/agent_hq')).toThrow(
      'must use the PostgreSQL protocol'
    )
    expect(() => assertLoopbackAuthDatabaseUrl('postgresql://127.0.0.1:5432/agent_hq')).toThrow(
      'must include a role and a password'
    )
  })

  test('the environment carries the URL and the process settings a test needs', () => {
    const environment = selfHostedAuthLifecycleEnvironment(loopbackUrl, {
      PATH: '/synthetic/bin',
      TMPDIR: '/tmp',
      LANG: 'C',
      DATABASE_URL: 'postgresql://someone:secret@db.example.com/agent_hq',
      AUTH_SECRET: 'untrusted',
      AUTH_BASE_URL: 'https://untrusted.example.test',
    })
    expect(environment).toEqual({
      PATH: '/synthetic/bin',
      TMPDIR: '/tmp',
      LANG: 'C',
      AUTH_POSTGRES_TEST_URL: loopbackUrl,
    })
  })
})
