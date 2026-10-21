/**
 * Target confinement and surface positive controls for the cutover rehearsals.
 *
 * Pure: nothing here opens a connection, so the negatives run before any
 * database is touched.
 */
import { expect, test } from 'bun:test'

import {
  assertScratchDatabaseName,
  assertServerIdentity,
  canonicalTargetUrl,
  parseLocalDisposableTarget,
} from '../fixtures/migration-cutover-target'
import { assertAuthorizedMemberSearch } from '../fixtures/migration-cutover-surface-evidence'

const CANONICAL = 'postgresql://postgres:0123456789abcdef@127.0.0.1:54329/postgres?sslmode=disable'

test('the canonical loopback capture target is accepted and kept canonical', () => {
  const target = parseLocalDisposableTarget(CANONICAL)
  expect(target.host).toBe('127.0.0.1')
  expect(target.port).toBe(54329)
  expect(target.user).toBe('postgres')
  expect(target.adminDatabase).toBe('postgres')
  expect(target.sslMode).toBe('disable')
})

test('a non-loopback target is refused, so an inherited URL cannot be used', () => {
  for (const host of ['db.example.com', '10.0.0.5', '0.0.0.0']) {
    expect(() =>
      parseLocalDisposableTarget(`postgresql://postgres:secret@${host}:5432/postgres`)
    ).toThrow('loopback')
  }
})

test('a startup or identity option is refused', () => {
  // Real query keys: the parser reads the key that is actually sent, so the
  // negatives name the parameter itself and not a '?'-prefixed spelling.
  const refused: Readonly<Record<string, string>> = {
    options: '-c%20search_path%3Dpublic',
    search_path: 'public',
    host: 'db.example.com',
    port: '5433',
    dbname: 'other',
    database: 'other',
    user: 'other',
    password: 'other',
    application_name: 'other',
    target_session_attrs: 'read-write',
    service: 'other',
    sslrootcert: '/tmp/other.crt',
  }
  for (const [key, value] of Object.entries(refused)) {
    expect(() => parseLocalDisposableTarget(`${CANONICAL}&${key}=${value}`)).toThrow()
  }
})

test('a percent-encoded parameter name is refused', () => {
  expect(() =>
    parseLocalDisposableTarget(`${CANONICAL}&%6fptions=-c%20search_path%3Dpublic`)
  ).toThrow('encoded parameter name')
  expect(() => parseLocalDisposableTarget(`${CANONICAL}&ssl%6dode=disable`)).toThrow(
    'encoded parameter name'
  )
})

test('a duplicate parameter is refused', () => {
  expect(() => parseLocalDisposableTarget(`${CANONICAL}&sslmode=disable`)).toThrow('repeat')
  expect(() => parseLocalDisposableTarget(`${CANONICAL}&sslmode=require`)).toThrow('repeat')
})

test('a requested TLS mode is preserved and an unsupported one is refused', () => {
  const required = parseLocalDisposableTarget(
    'postgresql://postgres:0123456789abcdef@127.0.0.1:54329/postgres?sslmode=require'
  )
  expect(required.sslMode).toBe('require')
  // The mode is carried onto the connection, never quietly downgraded.
  const requiredUrl = new URL(canonicalTargetUrl(required, 'rehearsal_1222_surface_abc'))
  expect(requiredUrl.searchParams.get('sslmode')).toBe('require')
  const preferred = parseLocalDisposableTarget(
    'postgresql://postgres:0123456789abcdef@127.0.0.1:54329/postgres?sslmode=prefer'
  )
  expect(preferred.sslMode).toBe('prefer')
  // A mode this target does not support is refused rather than substituted.
  for (const mode of ['verify-full', 'verify-ca', 'allow', 'true']) {
    expect(() =>
      parseLocalDisposableTarget(
        `postgresql://postgres:0123456789abcdef@127.0.0.1:54329/postgres?sslmode=${mode}`
      )
    ).toThrow('TLS mode')
  }
  // A target that named no mode keeps the driver's own default.
  const unspecified = parseLocalDisposableTarget(
    'postgresql://postgres:0123456789abcdef@127.0.0.1:54329/postgres'
  )
  expect(unspecified.sslMode).toBeUndefined()
  const unspecifiedUrl = new URL(canonicalTargetUrl(unspecified, 'rehearsal_1222_surface_abc'))
  expect(unspecifiedUrl.searchParams.has('sslmode')).toBe(false)
})

test('the canonical connection URL carries only the allowlisted parameter', () => {
  const target = parseLocalDisposableTarget(CANONICAL)
  const url = new URL(canonicalTargetUrl(target, 'rehearsal_1222_surface_abc'))
  expect(url.pathname).toBe('/rehearsal_1222_surface_abc')
  expect(url.username).toBe('postgres')
  expect(url.port).toBe('54329')
  expect([...url.searchParams.keys()]).toEqual(['sslmode'])
  expect(url.searchParams.get('sslmode')).toBe('disable')
})

test('a scratch database name outside the owned shape is refused', () => {
  expect(() => assertScratchDatabaseName('other_prefix_name', 'rehearsal_1222_')).toThrow(
    'scratch names need'
  )
  expect(() => assertScratchDatabaseName('rehearsal_1222_Bad-Name', 'rehearsal_1222_')).toThrow(
    'not a plain name'
  )
  expect(() => canonicalTargetUrl(parseLocalDisposableTarget(CANONICAL), 'Bad-Name')).toThrow(
    'not a plain lowercase name'
  )
})

test('a denied search cannot satisfy the positive control', () => {
  const seeded = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  expect(() => assertAuthorizedMemberSearch({ searchMessages: 'denied' }, seeded)).toThrow(
    'search was denied'
  )
  // The sentinel is a string: a length check alone would have counted it.
  expect('denied'.length).toBeGreaterThan(0)
})

test('a server identity mismatch is refused before anything is migrated', async () => {
  const matching = {
    execute: async () => [{ database: 'rehearsal_1222_surface_abc', user: 'postgres' }],
  }
  await expect(
    assertServerIdentity(matching, { database: 'rehearsal_1222_surface_abc', user: 'postgres' })
  ).resolves.toBeUndefined()
  const wrongDatabase = {
    execute: async () => [{ database: 'postgres', user: 'postgres' }],
  }
  await expect(
    assertServerIdentity(wrongDatabase, {
      database: 'rehearsal_1222_surface_abc',
      user: 'postgres',
    })
  ).rejects.toThrow('expected database and user identity')
  const wrongUser = {
    execute: async () => [{ database: 'rehearsal_1222_surface_abc', user: 'other' }],
  }
  await expect(
    assertServerIdentity(wrongUser, {
      database: 'rehearsal_1222_surface_abc',
      user: 'postgres',
    })
  ).rejects.toThrow('expected database and user identity')
  const empty = { execute: async () => [] }
  await expect(
    assertServerIdentity(empty, { database: 'rehearsal_1222_surface_abc', user: 'postgres' })
  ).rejects.toThrow('expected database and user identity')
})

test('only the exact seeded message ids satisfy the positive control', () => {
  const seeded = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  expect(() => assertAuthorizedMemberSearch({ searchMessages: seeded }, seeded)).not.toThrow()
  expect(() => assertAuthorizedMemberSearch({ searchMessages: [seeded[0]!] }, seeded)).toThrow(
    'exactly the seeded fixture messages'
  )
  expect(() => assertAuthorizedMemberSearch({ searchMessages: [] }, seeded)).toThrow(
    'exactly the seeded fixture messages'
  )
  expect(() =>
    assertAuthorizedMemberSearch(
      { searchMessages: [...seeded, '33333333-3333-4333-8333-333333333333'] },
      seeded
    )
  ).toThrow('exactly the seeded fixture messages')
})
