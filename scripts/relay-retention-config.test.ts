import { describe, expect, test } from 'bun:test'

import { parseRelayRetentionArguments, relayRetentionDatabaseUrl } from './relay-retention-config'

const workspace = '550e8400-e29b-41d4-a716-446655440000'
const args = [
  '--host',
  '127.0.0.1',
  '--port',
  '55433',
  '--database',
  'agent_hq',
  '--workspace',
  workspace,
  '--limit',
  '7',
]
const environment = {
  DATABASE_URL_UNPOOLED:
    'postgresql://fixture_app:PRIVATE_PASSWORD_SENTINEL@127.0.0.1:55433/agent_hq?sslmode=disable',
}

describe('relay retention operator target', () => {
  test('defaults to bounded dry-run and requires explicit mutation intent', () => {
    expect(parseRelayRetentionArguments(args)).toEqual({
      host: '127.0.0.1',
      port: 55433,
      database: 'agent_hq',
      workspaceId: workspace,
      limit: 7,
      apply: false,
    })
    expect(parseRelayRetentionArguments([...args, '--apply']).apply).toBe(true)
    expect(relayRetentionDatabaseUrl(parseRelayRetentionArguments(args), environment)).toBe(
      environment.DATABASE_URL_UNPOOLED
    )
  })

  test('refuses missing, duplicate, unknown and unbounded inputs', () => {
    for (const candidate of [
      [],
      args.slice(2),
      [...args, '--apply', '--apply'],
      [...args, '--host', 'other'],
      [...args, '--token', 'PRIVATE_TOKEN_SENTINEL'],
      args.map((x) => (x === '7' ? '1001' : x)),
      args.map((x) => (x === '7' ? '0' : x)),
      args.map((x) => (x === '7' ? '1.5' : x)),
      args.map((x) => (x === workspace ? 'all' : x)),
    ]) {
      expect(() => parseRelayRetentionArguments(candidate)).toThrow('invalid_arguments')
    }
  })

  test('refuses a wrong host, port or database before connecting', () => {
    const options = parseRelayRetentionArguments(args)
    for (const target of [
      { ...options, host: 'other.invalid' },
      { ...options, port: 55432 },
      { ...options, database: 'other' },
    ]) {
      expect(() => relayRetentionDatabaseUrl(target, environment)).toThrow('wrong_target')
    }
  })

  test('requires the separate app-role connection and sanitized diagnostics', () => {
    const options = parseRelayRetentionArguments(args)
    for (const candidate of [
      {},
      { DATABASE_MIGRATION_URL: environment.DATABASE_URL_UNPOOLED },
      { DATABASE_URL_UNPOOLED: 'PRIVATE_URL_SENTINEL' },
      {
        DATABASE_URL_UNPOOLED: environment.DATABASE_URL_UNPOOLED.replace(
          'fixture_app',
          'fixture_migration'
        ),
      },
      { ...environment, VITE_DATABASE_URL: 'PRIVATE_CLIENT_SENTINEL' },
      { DATABASE_URL_UNPOOLED: `${environment.DATABASE_URL_UNPOOLED}&host=other.invalid` },
    ]) {
      try {
        relayRetentionDatabaseUrl(options, candidate)
        throw new Error('expected refusal')
      } catch (error) {
        expect(String(error)).toContain('invalid_database')
        expect(String(error)).not.toContain('PRIVATE_')
        expect(String(error)).not.toContain('postgresql:')
      }
    }
  })

  test('requires TLS and a direct connection for a hosted target', () => {
    const options = { ...parseRelayRetentionArguments(args), host: 'ep-host.neon.tech', port: 5432 }
    const hosted = 'postgresql://fixture_app:PRIVATE_PASSWORD_SENTINEL@ep-host.neon.tech/agent_hq'
    expect(() => relayRetentionDatabaseUrl(options, { DATABASE_URL_UNPOOLED: hosted })).toThrow(
      'invalid_database'
    )
    expect(
      relayRetentionDatabaseUrl(options, { DATABASE_URL_UNPOOLED: `${hosted}?sslmode=require` })
    ).toBe(`${hosted}?sslmode=require`)
    expect(() =>
      relayRetentionDatabaseUrl(
        { ...options, host: 'ep-host-pooler.neon.tech' },
        {
          DATABASE_URL_UNPOOLED: hosted.replace('ep-host.', 'ep-host-pooler.') + '?sslmode=require',
        }
      )
    ).toThrow('invalid_database')
  })
})
