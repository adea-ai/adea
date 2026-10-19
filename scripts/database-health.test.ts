import { describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { libpqEnvironment, queryPrivileges } from './database-health.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const loopback = 'postgresql://agent_hq_local_app:app-pw@127.0.0.1:55432/agent_hq?sslmode=disable'

// psql is libpq: inherited PG* variables route its connection. PGHOSTADDR
// overrides the destination whatever PGHOST says, so a loopback DATABASE_URL
// that passed the target guard could still reach a remote server.
const inheritedRouting = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  PGHOSTADDR: '203.0.113.9',
  PGSERVICE: 'production',
  PGSERVICEFILE: '/etc/pg/service.conf',
  PGSYSCONFDIR: '/etc/pg',
  PGPASSFILE: '/home/someone/.pgpass',
  PGHOST: 'db.example.com',
  PGPORT: '6543',
  PGUSER: 'owner',
  PGOPTIONS: '-c search_path=prod',
  PGTARGETSESSIONATTRS: 'read-write',
  PGLOADBALANCEHOSTS: 'random',
  PGSSLROOTCERT: '/tmp/root.crt',
  pgservice: 'lowercase',
}

describe('the environment psql runs with', () => {
  test('no inherited libpq variable survives; only the URL names the destination', () => {
    const env = libpqEnvironment(loopback, inheritedRouting)
    for (const name of [
      'PGHOSTADDR',
      'PGSERVICE',
      'PGSERVICEFILE',
      'PGSYSCONFDIR',
      'PGPASSFILE',
      'PGOPTIONS',
      'PGTARGETSESSIONATTRS',
      'PGLOADBALANCEHOSTS',
      'PGSSLROOTCERT',
      'pgservice',
    ]) {
      expect(env).not.toHaveProperty(name)
    }
    expect(env.PGHOST).toBe('127.0.0.1')
    expect(env.PGPORT).toBe('55432')
    expect(env.PGUSER).toBe('agent_hq_local_app')
    expect(env.PGDATABASE).toBe('agent_hq')
    expect(env.PGPASSWORD).toBe('app-pw')
    expect(env.PGSSLMODE).toBe('disable')
    // Non-libpq variables pass through untouched.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/someone')
    // Whatever else is in the child environment, it holds exactly these PG* names.
    expect(
      Object.keys(env)
        .filter((name) => /^PG/i.test(name))
        .toSorted()
    ).toEqual([
      'PGCHANNELBINDING',
      'PGCONNECT_TIMEOUT',
      'PGDATABASE',
      'PGHOST',
      'PGPASSWORD',
      'PGPORT',
      'PGSSLMODE',
      'PGUSER',
    ])
  })

  test('a loopback URL with a remote PGHOSTADDR cannot keep a remote destination (stubbed spawn)', () => {
    const calls: { command: string; env: Record<string, string | undefined> }[] = []
    const spawn = ((command: string, _args: string[], options: { env: Record<string, string> }) => {
      calls.push({ command, env: options.env })
      return { status: 0, stdout: 'agent_hq_local_app|f|f|f|f|f|f|f\n', stderr: '' }
    }) as unknown as typeof import('node:child_process').spawnSync
    const result = queryPrivileges(loopback, { spawn, inherited: inheritedRouting })
    expect(result.role).toBe('agent_hq_local_app')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toBe('psql')
    const { env } = calls[0]!
    expect(env.PGHOSTADDR).toBeUndefined()
    expect(env.PGSERVICE).toBeUndefined()
    expect(env.PGSERVICEFILE).toBeUndefined()
    expect(env.PGHOST).toBe('127.0.0.1')
    // Nothing in the child environment names the remote address or host.
    expect(JSON.stringify(env)).not.toContain('203.0.113.9')
    expect(JSON.stringify(env)).not.toContain('db.example.com')
  })

  test('the real entry point hands psql a scrubbed environment (stub psql, no connection)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'adea-health-'))
    try {
      const record = join(directory, 'psql-env.txt')
      const stub = join(directory, 'psql')
      writeFileSync(
        stub,
        [
          '#!/bin/sh',
          `env | grep '^PG' | sort >> '${record}'`,
          `echo "---" >> '${record}'`,
          'case "$PGUSER" in',
          '  *_migration) echo "agent_hq_local_migration|t|t|f|f|f|f|f" ;;',
          '  *) echo "agent_hq_local_app|f|f|f|f|f|f|f" ;;',
          'esac',
          '',
        ].join('\n')
      )
      chmodSync(stub, 0o755)
      const result = spawnSync('node', [join(root, 'scripts/database-health.mjs')], {
        encoding: 'utf8',
        env: {
          ...inheritedRouting,
          PATH: `${directory}:${process.env.PATH}`,
          DATABASE_URL: loopback,
          DATABASE_MIGRATION_URL:
            'postgresql://agent_hq_local_migration:migration-pw@127.0.0.1:55432/agent_hq?sslmode=disable',
        },
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      const recorded = readFileSync(record, 'utf8')
      expect(recorded).toContain('PGHOST=127.0.0.1')
      for (const forbidden of [
        'PGHOSTADDR',
        'PGSERVICE',
        'PGSERVICEFILE',
        'PGSYSCONFDIR',
        '203.0.113.9',
        'db.example.com',
      ]) {
        expect(recorded).not.toContain(forbidden)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('the entry point checks its targets before it reads them', () => {
    const source = readFileSync(join(root, 'scripts/database-health.mjs'), 'utf8')
    expect(source.indexOf('assertLocalTestTargets()')).toBeGreaterThan(-1)
    expect(source.indexOf('assertLocalTestTargets()')).toBeLessThan(
      source.indexOf('process.env.DATABASE_URL')
    )
  })
})

describe('database privilege results', () => {
  test('decodes reserved credentials and applies libpq defaults without inherited routing', () => {
    const env = libpqEnvironment('postgresql://local%40app:p%3Aa%25ss@localhost/fixture', {})
    expect(env).toMatchObject({
      PGUSER: 'local@app',
      PGPASSWORD: 'p:a%ss',
      PGPORT: '5432',
      PGSSLMODE: 'prefer',
      PGCHANNELBINDING: 'prefer',
      PGDATABASE: 'fixture',
    })
    expect(libpqEnvironment(loopback + '&channel_binding=require', {}).PGCHANNELBINDING).toBe(
      'require'
    )
  })

  test('reports a missing client without leaking connection details', () => {
    const spawn = (() => ({
      error: Object.assign(new Error('private psql path'), { code: 'ENOENT' }),
      status: null,
    })) as unknown as typeof spawnSync
    expect(() => queryPrivileges(loopback, { spawn, inherited: {} })).toThrow(
      'psql is required for the database health check'
    )
  })

  test('redacts client failure details and rejects malformed result rows', () => {
    for (const status of [1, null]) {
      const spawn = (() => ({ status, stderr: loopback })) as unknown as typeof spawnSync
      expect(() => queryPrivileges(loopback, { spawn, inherited: {} })).toThrow(
        'Database health query failed; connection details were redacted'
      )
    }
    for (const stdout of ['', 'role|f|f', 'role|f|f|f|f|f|f|f|extra']) {
      const spawn = (() => ({ status: 0, stdout })) as unknown as typeof spawnSync
      expect(() => queryPrivileges(loopback, { spawn, inherited: {} })).toThrow(
        'Database health query returned an unexpected result'
      )
    }
  })

  test.each([3, 4, 5, 6, 7])('recognizes elevated role flag at field %s', (index) => {
    const fields = ['fixture_role', 'f', 'f', 'f', 'f', 'f', 'f', 'f']
    fields[index] = 't'
    const spawn = (() => ({
      status: 0,
      stdout: fields.join('|') + '\n',
    })) as unknown as typeof spawnSync
    expect(queryPrivileges(loopback, { spawn, inherited: {} })).toEqual({
      role: 'fixture_role',
      canCreateDatabaseObjects: false,
      canCreateSchemaObjects: false,
      elevated: true,
    })
  })
})

async function runHealthEntry(runtime: string, migration: string) {
  const directory = mkdtempSync(join(tmpdir(), 'adea-health-entry-'))
  const previous = { argv: process.argv, env: process.env, exitCode: process.exitCode }
  const output = spyOn(console, 'log').mockImplementation(() => {})
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const stub = join(directory, 'psql')
    writeFileSync(
      stub,
      `#!/bin/sh\ncase "$PGUSER" in\n*_migration) printf '%s\\n' '${migration}' ;;\n*) printf '%s\\n' '${runtime}' ;;\nesac\n`
    )
    chmodSync(stub, 0o755)
    process.argv = [process.execPath, join(root, 'scripts/database-health.mjs')]
    process.env = {
      PATH: `${directory}:/usr/bin:/bin`,
      DATABASE_URL: loopback,
      DATABASE_MIGRATION_URL:
        'postgresql://agent_hq_local_migration:fixture@127.0.0.1:55432/agent_hq?sslmode=disable',
    }
    process.exitCode = 0
    // A fresh module instance runs the unchanged CLI guard and main in the
    // instrumented process. Its psql executable is always this local stub.
    await import(`./database-health.mjs?entry=${crypto.randomUUID()}`)
    return {
      status: process.exitCode,
      output: output.mock.calls.flat().join('\n'),
      errors: errors.mock.calls.flat().join('\n'),
    }
  } finally {
    process.argv = previous.argv
    process.env = previous.env
    process.exitCode = previous.exitCode
    output.mockRestore()
    errors.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('database health command privilege boundary', () => {
  const runtime = 'agent_hq_local_app|f|f|f|f|f|f|f'
  const migration = 'agent_hq_local_migration|t|t|f|f|f|f|f'

  test('accepts exactly the runtime and migration roles with their required privileges', async () => {
    const result = await runHealthEntry(runtime, migration)
    expect(result.status).toBe(0)
    expect(result.errors).toBe('')
    expect(result.output).toContain(
      'Database health check passed (database=agent_hq, runtimeRole=agent_hq_local_app, migrationRole=agent_hq_local_migration)'
    )
  })

  test.each([
    'agent_hq_local_app|t|f|f|f|f|f|f',
    'agent_hq_local_app|f|t|f|f|f|f|f',
    'agent_hq_local_app|f|f|t|f|f|f|f',
  ])('rejects runtime DDL or elevated privilege: %s', async (row) => {
    const result = await runHealthEntry(row, migration)
    expect(result.status).toBe(1)
    expect(result.output).toBe('')
    expect(result.errors).toBe('Runtime database role has elevated or DDL privileges')
  })

  test.each([
    'agent_hq_local_migration|f|t|f|f|f|f|f',
    'agent_hq_local_migration|t|f|f|f|f|f|f',
    'agent_hq_local_migration|t|t|f|f|f|f|t',
  ])('rejects a migration role outside its required boundary: %s', async (row) => {
    const result = await runHealthEntry(runtime, row)
    expect(result.status).toBe(1)
    expect(result.output).toBe('')
    expect(result.errors).toBe(
      'Migration database role does not match the required privilege boundary'
    )
  })

  test.each([
    ['different_runtime|f|f|f|f|f|f|f', migration],
    [runtime, 'different_migration|t|t|f|f|f|f|f'],
  ])('rejects a connected role mismatch', async (runtimeRow, migrationRow) => {
    const result = await runHealthEntry(runtimeRow, migrationRow)
    expect(result.status).toBe(1)
    expect(result.errors).toBe('Connected database roles do not match the configured roles')
  })
})
