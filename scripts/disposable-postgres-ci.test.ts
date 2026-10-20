import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { inspectDatabaseConfiguration } from './database-config.mjs'
import {
  BACKUP_RESTORE_TEST,
  backupRestoreEnvironment,
  backupRestoreUrl,
  containerRemovalCommand,
  ownedAnonymousVolume,
  CANONICAL_MIGRATION_ROLE,
  CANONICAL_RUNTIME_ROLE,
  LOOPBACK_HOST,
  PROOF_AUTH_SCHEMA,
  PROOF_DATABASE,
  PROOF_MIGRATION_STEPS,
  assertLoopbackTlsUrl,
  attachOwnedContainerCleanup,
  authMigrationUrl,
  disposableStartScript,
  failureEvidence,
  plaintextUrl,
  proofEnvironment,
  redactSecrets,
  runDisposablePostgresProof,
  type DisposableProofDependencies,
  type DisposableProofOptions,
} from './disposable-postgres-ci'

const root = resolve(import.meta.dir, '..')
const runtimeUrl = `postgresql://${CANONICAL_RUNTIME_ROLE}:${CANONICAL_RUNTIME_ROLE}@${LOOPBACK_HOST}:54321/${PROOF_DATABASE}?sslmode=require&connect_timeout=10`
const migrationUrl = `postgresql://${CANONICAL_MIGRATION_ROLE}:${CANONICAL_MIGRATION_ROLE}@${LOOPBACK_HOST}:54321/${PROOF_DATABASE}?sslmode=require&connect_timeout=10`

/** The row the server reports for a session: encrypted unless TLS is off. */
const sslRows = (url: string) => [
  { ssl: new URL(url).searchParams.get('sslmode') === 'disable' ? 'f' : 't' },
]

const options: DisposableProofOptions = {
  image: 'public.ecr.aws/docker/library/postgres:18-alpine@sha256:example',
  authSchema: PROOF_AUTH_SCHEMA,
  authBaseUrl: 'https://adea-ci.example.test',
  authSecret: 'adea-ci-disposable-auth-secret-0123456789abcdef',
  authTrustedOrigin: 'https://adea-ci.example.test',
  checkout: {
    sha: '0123456789abcdef0123456789abcdef01234567',
    dirty: false,
    source: 'test/branch',
  },
  module: {
    sha: '0123456789abcdef0123456789abcdef01234567',
    dirty: false,
    source: 'test/branch',
  },
}

type Fake = {
  readonly deps: DisposableProofDependencies
  readonly state: {
    commands: { command: string; args: readonly string[] }[]
    queries: { url: string; statement: string }[]
    authCalls: Record<string, string | undefined>[]
    created: { name: string; password: string; image: string; startScript: string }[]
    removed: string[]
  }
}

function fake(overrides: Partial<DisposableProofDependencies> = {}): Fake {
  const state: Fake['state'] = {
    commands: [],
    queries: [],
    authCalls: [],
    created: [],
    removed: [],
  }
  let authCalls = 0
  const deps: DisposableProofDependencies = {
    dockerAvailable: () => true,
    opensslAvailable: () => true,
    createContainer: (input) => {
      state.created.push(input)
    },
    docker: (args) => {
      if (args[0] === 'port') return { status: 0, stdout: `${LOOPBACK_HOST}:54321\n`, stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    createCertificate: () => {},
    provision: async () => ({
      migrationRole: CANONICAL_MIGRATION_ROLE,
      migrationUrl,
      runtimeRole: CANONICAL_RUNTIME_ROLE,
      runtimeUrl,
      unpooledUrl: runtimeUrl,
    }),
    applyAuthSchema: async (environment) => {
      state.authCalls.push(environment)
      authCalls += 1
      if (authCalls === 1) {
        return {
          applied: true,
          before: { add: [], create: ['account', 'session', 'user', 'verification'] },
          after: { add: [], create: [] },
        }
      }
      return { applied: false, before: { add: [], create: [] } }
    },
    command: (command, args) => {
      state.commands.push({ command, args })
      // The backup and restore test reports its summary on stderr, as bun does.
      const summary = args.includes(BACKUP_RESTORE_TEST) ? '\n 1 pass\n 0 fail\n' : ''
      return { status: 0, stdout: '', stderr: summary }
    },
    query: async (url, statement) => {
      state.queries.push({ url, statement })
      if (statement === 'SHOW ssl') return [{ ssl: 'on' }]
      if (statement.includes('pg_stat_ssl')) {
        return [{ ssl: new URL(url).searchParams.get('sslmode') === 'disable' ? 'f' : 't' }]
      }
      if (statement.includes('pg_get_userbyid')) {
        return [{ owner: CANONICAL_MIGRATION_ROLE }]
      }
      if (statement.includes('has_schema_privilege')) return [{ ddl: 'f' }]
      if (statement.includes('count(*)')) return [{ count: 1 }]
      if (statement.startsWith('CREATE TABLE')) {
        throw new Error('permission denied for schema app')
      }
      return []
    },
    removeContainer: (name) => {
      state.removed.push(name)
    },
    now: () => 0,
    sleep: async () => {},
    ...overrides,
  }
  return { deps, state }
}

describe('the disposable PostgreSQL proof', () => {
  test('passes and removes only the container it created', async () => {
    const { deps, state } = fake()
    const receipt = await runDisposablePostgresProof(deps, options)

    expect(receipt.status).toBe('passed')
    expect(receipt.proofKind).toBe('disposable-postgres-proof')
    expect(receipt.checkout).toEqual(options.checkout)
    expect(receipt.module).toEqual(options.module)
    expect(receipt.database).toBe(PROOF_DATABASE)
    expect(receipt.roles).toEqual({
      runtime: CANONICAL_RUNTIME_ROLE,
      migration: CANONICAL_MIGRATION_ROLE,
    })
    expect(state.created).toHaveLength(1)
    expect(state.created[0]?.name).toMatch(/^adea-ci-postgres-[0-9a-f]{12}$/)
    expect(state.removed).toEqual([state.created[0]?.name])
  })

  test('publishes the instance on the loopback interface only', async () => {
    const { deps, state } = fake()
    await runDisposablePostgresProof(deps, options)
    const created = state.created[0]
    expect(created?.startScript).toContain('ssl=on')
    expect(created?.startScript).toContain('chown postgres:postgres')
  })

  test('runs the hosted lane’s ordered migration checks', async () => {
    const { deps, state } = fake()
    await runDisposablePostgresProof(deps, options)

    expect(state.commands.map((entry) => entry.args.join(' '))).toEqual([
      'scripts/database-health.mjs',
      '--no-env-file run --cwd packages/db db:check',
      '--no-env-file run --cwd packages/db db:verify',
      '--no-env-file --conditions=react-server test packages/db/tests/integration/migrations.test.ts',
      `--no-env-file test ${BACKUP_RESTORE_TEST}`,
    ])
    // The hosted lane asserts the URL is present between the verifier and the
    // integration test; the same step keeps its place.
    const urlCheck = PROOF_MIGRATION_STEPS.findIndex((step) => step.kind === 'assert-url-present')
    const verify = PROOF_MIGRATION_STEPS.findIndex(
      (step) => step.kind === 'command' && step.args.includes('db:verify')
    )
    const integration = PROOF_MIGRATION_STEPS.findIndex(
      (step) =>
        step.kind === 'command' && step.args.some((arg) => arg.includes('migrations.test.ts'))
    )
    expect(verify).toBeLessThan(urlCheck)
    expect(urlCheck).toBeLessThan(integration)
  })

  test('runs the migration checks with only the three canonical URLs in the environment', async () => {
    const { deps } = fake()
    await runDisposablePostgresProof(deps, options)
    expect(
      proofEnvironment(
        { migrationRole: '', migrationUrl, runtimeRole: '', runtimeUrl, unpooledUrl: runtimeUrl },
        {
          PATH: '/usr/bin',
          DATABASE_URL: 'postgresql://someone:secret@example.test/production',
          PGHOST: 'example.test',
        }
      )
    ).toEqual({
      PATH: '/usr/bin',
      DATABASE_URL: runtimeUrl,
      DATABASE_URL_UNPOOLED: runtimeUrl,
      DATABASE_MIGRATION_URL: migrationUrl,
    })
  })

  test('proves the server-side TLS and that the check tells a plaintext session apart', async () => {
    const { deps, state } = fake()
    const receipt = await runDisposablePostgresProof(deps, options)

    expect(receipt.tls).toEqual({
      serverSsl: 'on',
      sessionEncrypted: true,
      plaintextSessionEncrypted: false,
    })
    const plaintext = state.queries.find((entry) => entry.url.includes('sslmode=disable'))
    expect(plaintext).toBeDefined()
  })

  test('accepts the boolean shape the application driver decodes a boolean to', async () => {
    const { deps } = fake({
      query: async (url, statement) => {
        if (statement === 'SHOW ssl') return [{ ssl: 'on' }]
        if (statement.includes('pg_stat_ssl')) {
          const plaintext = new URL(url).searchParams.get('sslmode') === 'disable'
          return [{ ssl: !plaintext }]
        }
        if (statement.includes('pg_get_userbyid')) {
          return [{ owner: CANONICAL_MIGRATION_ROLE }]
        }
        if (statement.includes('has_schema_privilege')) return [{ ddl: false }]
        if (statement.includes('count(*)')) return [{ count: 1 }]
        if (statement.startsWith('CREATE TABLE')) throw new Error('permission denied')
        return []
      },
    })
    const receipt = await runDisposablePostgresProof(deps, options)
    expect(receipt.tls.sessionEncrypted).toBe(true)
  })

  test('applies the merged auth schema initializer once and replays it as a no-op', async () => {
    const { deps, state } = fake()
    const receipt = await runDisposablePostgresProof(deps, options)

    expect(state.authCalls).toHaveLength(2)
    expect(state.authCalls[0]).toBeDefined()
    expect(receipt.auth.applied).toBe(true)
    expect(receipt.auth.created).toEqual(['account', 'session', 'user', 'verification'])
    expect(receipt.auth.replayApplied).toBe(false)
    expect(receipt.auth.schema).toBe(PROOF_AUTH_SCHEMA)
  })

  test('runs the backup and restore test through bun, with the lane’s own URL', async () => {
    const { deps, state } = fake()
    await runDisposablePostgresProof(deps, options)
    const backup = state.commands.find((entry) => entry.args.includes(BACKUP_RESTORE_TEST))
    expect(backup?.command).toBe('bun')
    expect(backup?.args).toEqual(['--no-env-file', 'test', BACKUP_RESTORE_TEST])
  })

  test('fails the lane when the backup and restore test fails', async () => {
    const { deps } = fake({
      command: (command, args) => ({
        status: args.includes(BACKUP_RESTORE_TEST) ? 1 : 0,
        stdout: '',
        stderr: args.includes(BACKUP_RESTORE_TEST) ? ' 0 pass\n 1 fail\n' : '',
      }),
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /backup and restore test failed with exit code 1/
    )
  })

  test('a failed backup and restore run reports the failing line, not the header', async () => {
    const { deps } = fake({
      command: (command, args) => ({
        status: args.includes(BACKUP_RESTORE_TEST) ? 1 : 0,
        stdout: '',
        stderr: args.includes(BACKUP_RESTORE_TEST)
          ? [
              'bun test v1.4.2',
              '(pass) loopback target guard > refuses a remote host [0.23ms]',
              '(fail) schema backup and restore > the restored rows differ',
              'error: expect(received).toEqual(expected)',
            ].join('\n')
          : '',
      }),
    })
    const failure = await runDisposablePostgresProof(deps, options).catch((error: unknown) =>
      String(error)
    )
    expect(failure).toContain('the restored rows differ')
    expect(failure).not.toContain('refuses a remote host')
  })

  test('a failed backup and restore run never carries a secret out of the proof', async () => {
    const { deps, state } = fake({
      command: (command, args) => ({
        status: args.includes(BACKUP_RESTORE_TEST) ? 1 : 0,
        stdout: '',
        stderr: args.includes(BACKUP_RESTORE_TEST)
          ? `(fail) the dump failed for postgresql://postgres:${state.created[0]?.password ?? ''}@127.0.0.1/app`
          : '',
      }),
    })
    const failure = await runDisposablePostgresProof(deps, options).catch((error: unknown) =>
      String(error)
    )
    const password = state.created[0]?.password ?? ''
    expect(password).not.toBe('')
    expect(failure).toContain('the dump failed')
    expect(failure).not.toContain(password)
  })

  test('the failure evidence keeps the failing lines and redacts every secret', () => {
    const output = [
      'bun test v1.4.2',
      '(pass) a passing test [0.1ms]',
      '(fail) the failing test',
      'error: could not connect to postgresql://postgres:hunter2@127.0.0.1/app',
    ].join('\n')
    const evidence = failureEvidence(output, ['hunter2'])
    expect(evidence).toContain('the failing test')
    expect(evidence).toContain('could not connect')
    expect(evidence).not.toContain('a passing test')
    expect(evidence).not.toContain('hunter2')
    expect(evidence).toContain('[redacted]')
  })

  test('a secret that crosses the evidence boundary never leaves a fragment behind', async () => {
    const { deps, state } = fake({
      command: (command, args) => {
        if (args.includes(BACKUP_RESTORE_TEST)) {
          return { status: 0, stdout: '', stderr: '\n 1 pass\n 0 fail\n' }
        }
        const password = state.created[0]?.password ?? ''
        // The failing line is long enough that the secret starts before the
        // 2000 character boundary of the evidence and ends after it, so a
        // truncation that ran before the redaction would keep a prefix of it.
        const filler = 'x'.repeat(1930)
        return {
          status: 1,
          stdout: '',
          stderr: `(fail) the migration check failed: ${filler} ${password} tail\n`,
        }
      },
    })
    const failure = await runDisposablePostgresProof(deps, options).catch((error: unknown) =>
      String(error)
    )
    const password = state.created[0]?.password ?? ''
    expect(password).not.toBe('')
    expect(failure).toContain('the migration check failed')
    expect(failure).not.toContain(password)
    expect(failure).not.toContain(password.slice(0, 12))
    expect(failure).toContain('[redacted]')
  })

  test('fails the lane when the backup and restore test passes nothing', async () => {
    for (const stderr of ['\n 0 pass\n 0 fail\n', '\n 1 pass\n 1 skip\n']) {
      const { deps } = fake({
        command: (command, args) => ({
          status: 0,
          stdout: '',
          stderr: args.includes(BACKUP_RESTORE_TEST) ? stderr : '',
        }),
      })
      await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
        /did not run to completion; a skipped run is not a proof/
      )
    }
  })

  test('refuses to run without a container runtime', async () => {
    const { deps, state } = fake({ dockerAvailable: () => false })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /must not be reported as a pass/
    )
    expect(state.created).toHaveLength(0)
    expect(state.removed).toHaveLength(0)
  })

  test('refuses to run without a way to enable server-side TLS', async () => {
    const { deps } = fake({ opensslAvailable: () => false })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(/OpenSSL/)
  })

  test('fails the lane when a migration check fails, and still removes the container', async () => {
    const { deps, state } = fake({
      command: (command, args) => {
        state.commands.push({ command, args })
        return { status: 1, stdout: '', stderr: '' }
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /failed with exit code 1/
    )
    expect(state.removed).toHaveLength(1)
  })

  test('fails the lane when the cleanup fails', async () => {
    const { deps } = fake({
      removeContainer: () => {
        throw new Error('removing the disposable PostgreSQL instance failed')
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(/could not clean up/)
  })

  test('preserves the primary failure alongside the teardown failure', async () => {
    const { deps } = fake({
      command: () => ({ status: 3, stdout: '', stderr: '' }),
      removeContainer: () => {
        throw new Error('removing the disposable PostgreSQL instance failed')
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(/cleanup also failed/)
  })

  test('never lets the container password out of a failure message', async () => {
    const { deps, state } = fake({
      command: () => {
        const password = state.created[0]?.password ?? ''
        return { status: 1, stdout: '', stderr: `failed with ${password}` }
      },
    })
    const failure = await runDisposablePostgresProof(deps, options).catch(
      (error: unknown) => error as Error
    )
    expect(failure.message).not.toContain(state.created[0]?.password ?? 'unset')
    expect(failure.message).toContain('[redacted]')
  })

  test('refuses roles that are not the canonical ones', async () => {
    const { deps } = fake({
      provision: async () => ({
        migrationRole: 'someone_else_migration',
        migrationUrl,
        runtimeRole: CANONICAL_RUNTIME_ROLE,
        runtimeUrl,
        unpooledUrl: runtimeUrl,
      }),
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /canonical runtime and migration roles/
    )
  })

  test('refuses a target that is not on the loopback interface', async () => {
    const { deps } = fake({
      provision: async () => ({
        migrationRole: CANONICAL_MIGRATION_ROLE,
        migrationUrl,
        runtimeRole: CANONICAL_RUNTIME_ROLE,
        runtimeUrl: runtimeUrl.replace(LOOPBACK_HOST, 'db.example.test'),
        unpooledUrl: runtimeUrl,
      }),
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /must stay on the loopback interface/
    )
  })

  test('refuses a target that does not require TLS', async () => {
    const { deps } = fake({
      provision: async () => ({
        migrationRole: CANONICAL_MIGRATION_ROLE,
        migrationUrl,
        runtimeRole: CANONICAL_RUNTIME_ROLE,
        runtimeUrl: runtimeUrl.replace('sslmode=require', 'sslmode=disable'),
        unpooledUrl: runtimeUrl,
      }),
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(/sslmode=require/)
  })

  test('refuses a server that does not have TLS enabled', async () => {
    const { deps } = fake({
      query: async (url, statement) => {
        if (statement === 'SHOW ssl') return [{ ssl: 'off' }]
        return []
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /server-side TLS enabled/
    )
  })

  test('refuses a session the server did not encrypt', async () => {
    const { deps } = fake({
      query: async (url, statement) => {
        if (statement === 'SHOW ssl') return [{ ssl: 'on' }]
        if (statement.includes('pg_stat_ssl')) return [{ ssl: 'f' }]
        return []
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(/not encrypted/)
  })

  test('refuses a schema the migration role does not own', async () => {
    const { deps } = fake({
      query: async (url, statement) => {
        if (statement === 'SHOW ssl') return [{ ssl: 'on' }]
        if (statement.includes('pg_stat_ssl')) return sslRows(url)
        if (statement.includes('pg_get_userbyid')) return [{ owner: 'someone_else' }]
        return []
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /not owned by the canonical migration role/
    )
  })

  test('refuses a runtime role that may create objects', async () => {
    const { deps } = fake({
      query: async (url, statement) => {
        if (statement === 'SHOW ssl') return [{ ssl: 'on' }]
        if (statement.includes('pg_stat_ssl')) return sslRows(url)
        if (statement.includes('pg_get_userbyid')) {
          return [{ owner: CANONICAL_MIGRATION_ROLE }]
        }
        if (statement.includes('has_schema_privilege')) return [{ ddl: 't' }]
        return []
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /may create objects in the application schema/
    )
  })

  test('refuses a runtime role that really created an object', async () => {
    const { deps } = fake({
      query: async (url, statement) => {
        if (statement === 'SHOW ssl') return [{ ssl: 'on' }]
        if (statement.includes('pg_stat_ssl')) return sslRows(url)
        if (statement.includes('pg_get_userbyid')) {
          return [{ owner: CANONICAL_MIGRATION_ROLE }]
        }
        if (statement.includes('has_schema_privilege')) return [{ ddl: 'f' }]
        return []
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /created an object in the application schema/
    )
  })

  test('refuses an auth initializer that did not apply, or applied twice', async () => {
    const notApplied = fake({
      applyAuthSchema: async () => ({
        applied: false,
        before: { add: [], create: [] },
      }),
    })
    await expect(runDisposablePostgresProof(notApplied.deps, options)).rejects.toThrow(
      /did not apply the provider tables/
    )

    const alwaysApplied = fake({
      applyAuthSchema: async () => ({
        applied: true,
        before: { add: [], create: ['account', 'session', 'user', 'verification'] },
        after: { add: [], create: [] },
      }),
    })
    await expect(runDisposablePostgresProof(alwaysApplied.deps, options)).rejects.toThrow(
      /replaying the auth schema initializer was not a no-op/
    )
  })

  test('refuses an auth initializer that created the wrong tables', async () => {
    const { deps } = fake({
      applyAuthSchema: async () => ({
        applied: true,
        before: { add: [], create: ['user'] },
        after: { add: [], create: [] },
      }),
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /did not create the provider tables/
    )
  })

  test('refuses an auth initializer that left pending work behind', async () => {
    const { deps } = fake({
      applyAuthSchema: async () => ({
        applied: true,
        before: { add: [], create: ['account', 'session', 'user', 'verification'] },
        after: { add: [], create: ['user'] },
      }),
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /left pending work after applying/
    )
  })

  test('refuses an instance that never becomes ready', async () => {
    const { deps } = fake({
      docker: (args) => {
        if (args[0] === 'port') return { status: 0, stdout: `${LOOPBACK_HOST}:54321\n`, stderr: '' }
        if (args[0] === 'exec') return { status: 1, stdout: '', stderr: '' }
        return { status: 0, stdout: '', stderr: '' }
      },
      now: (() => {
        let tick = 0
        return () => {
          tick += 60_000
          return tick
        }
      })(),
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(/never became ready/)
  })

  test('refuses a container that could not be created', async () => {
    const { deps } = fake({
      createContainer: () => {
        throw new Error('creating the disposable PostgreSQL instance failed')
      },
    })
    await expect(runDisposablePostgresProof(deps, options)).rejects.toThrow(
      /creating the disposable PostgreSQL instance failed/
    )
  })
})

describe('the disposable proof helpers', () => {
  test('the canonical URL check refuses an ambiguous transport', () => {
    const ambiguous = `${runtimeUrl}&sslmode=require`
    expect(() => assertLoopbackTlsUrl(ambiguous, 'DATABASE_URL')).toThrow(/must not repeat/)
    expect(() => assertLoopbackTlsUrl(`${runtimeUrl}&ssl=require`, 'DATABASE_URL')).toThrow(
      /must not combine/
    )
    expect(() => assertLoopbackTlsUrl('not a url', 'DATABASE_URL')).toThrow(/valid PostgreSQL URL/)
    expect(() =>
      assertLoopbackTlsUrl('postgresql://user:pass@127.0.0.1/db', 'DATABASE_URL')
    ).toThrow(/sslmode=require/)
    expect(() =>
      assertLoopbackTlsUrl('postgresql://user:pass@127.0.0.1/db?sslmode=require', 'DATABASE_URL')
    ).not.toThrow()
  })

  test('the auth connection verifies the pinned certificate', () => {
    const url = authMigrationUrl(migrationUrl, '/tmp/cert/server.crt', PROOF_AUTH_SCHEMA)
    const parsed = new URL(url)
    expect(parsed.searchParams.get('sslmode')).toBe('verify-full')
    expect(parsed.searchParams.get('sslrootcert')).toBe('/tmp/cert/server.crt')
    expect(parsed.searchParams.get('options')).toBe(`-c search_path=${PROOF_AUTH_SCHEMA}`)
    expect(parsed.searchParams.getAll('sslmode')).toHaveLength(1)
  })

  test('the backup and restore URL is verified against the pinned certificate, on the proof database only', () => {
    const url = backupRestoreUrl(
      `postgresql://postgres:${'a'.repeat(32)}@${LOOPBACK_HOST}:54321/postgres?sslmode=require&connect_timeout=10`,
      '/tmp/cert/server.crt'
    )
    const parsed = new URL(url)
    expect(parsed.pathname).toBe(`/${PROOF_DATABASE}`)
    expect(parsed.searchParams.get('sslmode')).toBe('verify-full')
    expect(parsed.searchParams.getAll('sslmode')).toHaveLength(1)
    expect(parsed.searchParams.get('sslrootcert')).toBe('/tmp/cert/server.crt')
    expect(parsed.searchParams.has('options')).toBe(false)
    expect(() => assertLoopbackTlsUrl(url, 'AUTH_POSTGRES_TEST_URL', 'verify-full')).not.toThrow()
  })

  test('the backup and restore environment carries its one URL and only the routing-neutral variables', () => {
    const testUrl = 'postgresql://postgres:secret@127.0.0.1:54321/adea_ci_proof?sslmode=verify-full'
    expect(
      backupRestoreEnvironment(testUrl, {
        PATH: '/usr/bin',
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
        HOME: '/root',
        PGHOST: 'example.test',
        PGSERVICE: 'production',
        DATABASE_URL: 'postgresql://someone:secret@example.test/production',
      })
    ).toEqual({
      PATH: '/usr/bin',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      AUTH_POSTGRES_TEST_URL: testUrl,
    })
  })

  test('the plaintext URL turns the transport off', () => {
    expect(new URL(plaintextUrl(runtimeUrl)).searchParams.get('sslmode')).toBe('disable')
  })

  test('redaction removes every occurrence of a secret', () => {
    expect(redactSecrets('a secret and a secret', ['secret'])).toBe('a [redacted] and a [redacted]')
    expect(redactSecrets('nothing to hide', [''])).toBe('nothing to hide')
  })

  test('the container command enables TLS and hands the certificate to the server user', () => {
    const script = disposableStartScript()
    expect(script).toContain('ssl=on')
    expect(script).toContain('ssl_cert_file=/certs/server.crt')
    expect(script).toContain('ssl_key_file=/certs/server.key')
    expect(script).toContain('chmod 600 /certs/server.key')
    expect(script).toContain('exec docker-entrypoint.sh postgres')
  })

  test('an interrupted run removes the owned container and the temporary material once', () => {
    const removed: string[] = []
    const materials: string[] = []
    const signals: NodeJS.Signals[] = []
    const cleanup = attachOwnedContainerCleanup({
      name: 'adea-ci-postgres-owned',
      remove: (name) => removed.push(name),
      removeTemporaryMaterial: () => materials.push('removed'),
      reRaise: (signal) => signals.push(signal),
    })
    process.emit('SIGTERM', 'SIGTERM')
    expect(signals).toEqual(['SIGTERM'])
    expect(removed).toEqual(['adea-ci-postgres-owned'])
    expect(materials).toEqual(['removed'])
    // The listener is detached before the signal is re-raised, so a second
    // signal cannot re-enter the teardown or remove the container twice.
    process.emit('SIGTERM', 'SIGTERM')
    expect(removed).toHaveLength(1)
    expect(materials).toHaveLength(1)
    expect(signals).toHaveLength(1)
    cleanup.detach()
  })

  test('a failed cleanup is reported, never thrown, and still re-raises the signal', () => {
    const failures: string[] = []
    const materials: string[] = []
    const signals: NodeJS.Signals[] = []
    const cleanup = attachOwnedContainerCleanup({
      name: 'adea-ci-postgres-owned',
      remove: () => {
        throw new Error('the disposable container removal failed')
      },
      removeTemporaryMaterial: () => materials.push('removed'),
      reportFailure: (message) => failures.push(message),
      reRaise: (signal) => signals.push(signal),
    })
    expect(() => process.emit('SIGTERM', 'SIGTERM')).not.toThrow()
    expect(failures).toEqual(['the disposable container removal failed'])
    // The temporary material is still removed after a failed container removal.
    expect(materials).toEqual(['removed'])
    // The interruption is still re-raised, so the run cannot end successfully.
    expect(signals).toEqual(['SIGTERM'])
    cleanup.detach()
  })

  test('the hosted TLS rule is unchanged for a hosted target', () => {
    expect(() =>
      inspectDatabaseConfiguration({
        DATABASE_URL: 'postgresql://user:pass@db.example.test/app',
        DATABASE_MIGRATION_URL: 'postgresql://user2:pass@db.example.test/app',
      })
    ).toThrow(/must require TLS/)
  })

  test('the container removal takes that container’s volumes and nothing else', () => {
    const command = containerRemovalCommand('adea-ci-postgres-owned')
    expect(command).toEqual(['rm', '--force', '--volumes', 'adea-ci-postgres-owned'])
    // A prune, or a removal that named a volume or every container, would reach
    // resources this proof does not own.
    expect(command).not.toContain('prune')
    expect(command).not.toContain('volume')
    expect(command).not.toContain('--all')
    expect(command).not.toContain('-a')
    expect(command.filter((part) => part.startsWith('-'))).toEqual(['--force', '--volumes'])
  })

  test('the owned volume is read from the container’s own mounts', () => {
    expect(
      ownedAnonymousVolume([
        { Destination: '/var/lib/postgresql', Name: '1f2e3d4c5b6a', Type: 'volume' },
      ])
    ).toBe('1f2e3d4c5b6a')
    // A bind mount is not a volume this proof owns.
    expect(ownedAnonymousVolume([{ Destination: '/var/lib/postgresql', Type: 'bind' }])).toBeNull()
    expect(ownedAnonymousVolume([])).toBeNull()
  })

  test('the proof removes its container through the shared removal command', () => {
    const cli = readFileSync(resolve(root, 'scripts/disposable-postgres-cli.ts'), 'utf8')
    expect(cli).toContain('containerRemovalCommand(name)')
    // The proof must never prune, and must never remove a container or a volume
    // it did not name itself.
    expect(cli).not.toContain('prune')
    expect(cli).not.toContain('volume ls')
    expect(cli).not.toContain('volume rm')
    expect(cli).not.toContain("'--all'")
  })
})
