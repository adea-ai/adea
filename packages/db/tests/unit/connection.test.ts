import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { npmVersion as drizzleVersion } from 'drizzle-orm/version'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'

import { createDatabase, databaseConnectionOptions } from '../../src/connection'
import * as schema from '../../src/schema'
import { workspaces } from '../../src/schema'

// createDatabase builds its drizzle database itself so the relational schema config is derived once
// per isolate instead of once per client. These tests hold that construction to drizzle's own, and
// fail on a drizzle-orm upgrade so the copied `construct` is re-read against the new one.

// A URL nothing listens on: postgres-js connects lazily, so no test below ever opens a socket.
const URL_FOR_CONSTRUCTION = 'postgresql://user:password@127.0.0.1:1/construction_only'

function referenceDatabase() {
  const client = postgres(URL_FOR_CONSTRUCTION, { max: 10, prepare: false })
  return { client, db: drizzle(client, { schema }) }
}

// A table's resolved columns and relations, compared by name, not by object identity.
function shape(table: { columns: object; relations: object } | undefined) {
  return {
    columns: Object.keys(table?.columns ?? {}),
    relations: Object.keys(table?.relations ?? {}),
  }
}

function options(client: unknown) {
  return (
    client as {
      options: {
        parsers: Record<string, (value: unknown) => unknown>
        serializers: Record<string, (value: unknown) => unknown>
      }
    }
  ).options
}

describe('createDatabase construction', () => {
  test('was written against drizzle-orm 0.45.3; any other version needs the copy re-read', () => {
    expect(drizzleVersion).toBe('0.45.3')
  })

  test('derives the same relational config as drizzle(client, { schema })', async () => {
    const reference = referenceDatabase()
    const created = createDatabase(URL_FOR_CONSTRUCTION)
    try {
      expect(created.db._.tableNamesMap).toEqual(reference.db._.tableNamesMap)
      expect(Object.keys(created.db._.schema ?? {}).toSorted()).toEqual(
        Object.keys(reference.db._.schema ?? {}).toSorted()
      )
      expect(created.db._.fullSchema).toBe(reference.db._.fullSchema)
      // drizzle assigns its configured cache to $cache; with none configured both are undefined.
      expect(created.db.$cache).toBe(reference.db.$cache)
      expect(Object.keys(created.db.query).toSorted()).toEqual(
        Object.keys(reference.db.query).toSorted()
      )
      for (const name of Object.keys(reference.db._.schema ?? {})) {
        expect(shape(created.db._.schema?.[name])).toEqual(shape(reference.db._.schema?.[name]))
      }
    } finally {
      await created.close()
      await reference.client.end({ timeout: 1 })
    }
  })

  test('generates the same SQL for select, insert and relational queries', async () => {
    const reference = referenceDatabase()
    const created = createDatabase(URL_FOR_CONSTRUCTION)
    try {
      const builders = (db: typeof created.db) => [
        db.select().from(workspaces).limit(3).toSQL(),
        db.query.workspaces.findFirst({ columns: { id: true } }).toSQL(),
        db
          .insert(workspaces)
          .values({ name: 'probe' } as typeof workspaces.$inferInsert)
          .onConflictDoNothing()
          .toSQL(),
      ]
      expect(builders(created.db)).toEqual(builders(reference.db))
    } finally {
      await created.close()
      await reference.client.end({ timeout: 1 })
    }
  })

  test('configures the client parsers and serializers exactly as drizzle does', async () => {
    const reference = referenceDatabase()
    const created = createDatabase(URL_FOR_CONSTRUCTION)
    try {
      const expected = options(reference.client)
      const actual = options(created.client)
      expect(Object.keys(actual.parsers).toSorted()).toEqual(
        Object.keys(expected.parsers).toSorted()
      )
      expect(Object.keys(actual.serializers).toSorted()).toEqual(
        Object.keys(expected.serializers).toSorted()
      )
      // The timestamp, date, interval, json and jsonb types pass through untouched in both.
      for (const type of ['1184', '1082', '1083', '1114', '1182', '1185', '1115', '1231']) {
        expect(actual.parsers[type]?.('2026-01-01')).toBe('2026-01-01')
        expect(actual.serializers[type]?.('2026-01-01')).toBe('2026-01-01')
      }
      for (const type of ['114', '3802']) {
        expect(actual.serializers[type]?.('{"a":1}')).toBe('{"a":1}')
      }
    } finally {
      await created.close()
      await reference.client.end({ timeout: 1 })
    }
  })

  test('shares only the static schema config: every call gets its own client, session and database', async () => {
    const first = createDatabase(URL_FOR_CONSTRUCTION)
    const second = createDatabase(URL_FOR_CONSTRUCTION)
    try {
      expect(first.db._.schema).toBe(second.db._.schema)
      expect(first.db._.tableNamesMap).toBe(second.db._.tableNamesMap)
      expect(first.db._.fullSchema).toBe(schema)
      expect(first.client).not.toBe(second.client)
      expect(first.db).not.toBe(second.db)
      expect(first.db.$client).toBe(first.client)
      expect(second.db.$client).toBe(second.client)
      expect((first.db as unknown as { session: unknown }).session).not.toBe(
        (second.db as unknown as { session: unknown }).session
      )
    } finally {
      await first.close()
      await second.close()
    }
  })

  test('configures no database-level query cache for auth, session or permission reads', async () => {
    const { db, close } = createDatabase(URL_FOR_CONSTRUCTION)
    try {
      // drizzle reads `$cache` for its cache strategy; a configured cache would
      // be an object here. The session is handed no cache either, so its own
      // cache stays drizzle's NoopCache rather than a store.
      expect((db as unknown as { $cache: unknown }).$cache).toBeUndefined()
      const session = (db as unknown as { session: { options: unknown } }).session
      expect(session.options).toEqual({ logger: undefined, cache: undefined })
    } finally {
      await close()
    }
  })
})

describe('databaseConnectionOptions', () => {
  const RETIRED_POOLED_ENDPOINT =
    'postgresql://app:secret@ep-cool-1234-pooler.us-east-2.aws.neon.tech/agent_hq?sslmode=require'

  test('prepares statements for a direct connection and bounds the pool', () => {
    expect(databaseConnectionOptions()).toEqual({
      max: 10,
      connect_timeout: 10,
      idle_timeout: 20,
      prepare: true,
    })
  })

  test('keeps the previous ceilings for local development', () => {
    expect(databaseConnectionOptions()).toMatchObject({ max: 10, prepare: true })
  })

  test('prepares statements for every origin, including a retired provider endpoint', async () => {
    // No hostname decides the statement mode any more. The endpoint shape that used to force
    // `prepare: false` belonged to the provider this deployment has left, so a client opened
    // against it prepares statements like every other origin.
    const { client, close } = createDatabase(RETIRED_POOLED_ENDPOINT)
    try {
      expect((client.options as { prepare: boolean }).prepare).toBe(true)
    } finally {
      await close()
    }
  })

  test('caps a Cloudflare Worker client at five edge connections', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: 'Cloudflare-Workers' },
        configurable: true,
        writable: true,
      })
      expect(databaseConnectionOptions()).toMatchObject({ max: 5, prepare: true })
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
    }
  })

  test('honors explicit overrides for tests, fixtures and migration roles', () => {
    expect(
      databaseConnectionOptions({
        maxConnections: 1,
        preparedStatements: true,
        connectTimeoutSeconds: 3,
        idleTimeoutSeconds: 5,
      })
    ).toEqual({ max: 1, connect_timeout: 3, idle_timeout: 5, prepare: true })
  })

  test('lets a declared transaction-pooled origin turn preparation off', () => {
    expect(databaseConnectionOptions({ preparedStatements: false })).toMatchObject({
      prepare: false,
    })
  })
})

// A second real client standing in for the connection scope `begin()` and `savepoint()` hand
// to their callbacks. A real scope needs a server; what matters here is that statements run on
// the scope's own `unsafe`, not the outer client's.
function stubScopes(client: Sql, scope: Sql) {
  const enter = (callback: (sql: Sql) => unknown) => callback(scope)
  ;(client as { begin: unknown }).begin = enter
  ;(scope as { savepoint: unknown }).savepoint = enter
}

// The driver option is not enough: drizzle's postgres-js session runs every statement through
// `client.unsafe(sql, params)`, and Postgres.js builds those queries unprepared by default. These
// tests wrap `unsafe()` on real Postgres.js clients, build the real Query objects, and record
// whether Postgres.js would send each as a prepared statement (it prepares only when the client
// option and the query option agree). The wrapped call answers with a stub, so nothing connects.
describe('prepared statements on the drizzle path', () => {
  const HOSTED = 'postgresql://app:secret@db.example.com:5432/agent_hq?sslmode=require'

  type Statement = { sql: string; prepared: boolean }

  // Postgres.js: `options.prepare && ('prepare' in q.options ? q.options.prepare : true)`.
  function record(client: Sql, into: Statement[]) {
    const unsafe = client.unsafe.bind(client)
    ;(client as { unsafe: unknown }).unsafe = (...args: Parameters<Sql['unsafe']>) => {
      const query = unsafe(...args) as unknown as { options: { prepare?: boolean } }
      const clientPrepare = (client.options as { prepare: boolean }).prepare
      into.push({
        sql: String(args[0]),
        prepared: clientPrepare && ('prepare' in query.options ? !!query.options.prepare : true),
      })
      // The Query is dropped unawaited: Postgres.js queries are lazy and never ran.
      return Object.assign(Promise.resolve([]), { values: () => Promise.resolve([]) })
    }
  }

  function build(url = HOSTED) {
    const outer: Statement[] = []
    const scoped: Statement[] = []
    const { client, db } = createDatabase(url)
    const scope = postgres(url, databaseConnectionOptions())
    record(client, outer)
    record(scope, scoped)
    stubScopes(client, scope)
    const close = async () => {
      await client.end({ timeout: 0 })
      await scope.end({ timeout: 0 })
    }
    return { db, outer, scoped, close }
  }

  test('the driver is created with prepare: true for a Hyperdrive or direct host', async () => {
    const { client, close } = createDatabase(HOSTED)
    try {
      expect((client.options as { prepare: boolean }).prepare).toBe(true)
    } finally {
      await close()
    }
  })

  test('raw, builder and relational queries are prepared', async () => {
    const { db, outer, close } = build()
    try {
      await db.execute(sql`select ${1}::int`)
      await db.select().from(workspaces).where(eq(workspaces.id, 'w1'))
      await db.query.workspaces.findFirst({ where: eq(workspaces.id, 'w1') })
      expect(outer.length).toBe(3)
      for (const statement of outer) expect(statement.prepared).toBe(true)
    } finally {
      await close()
    }
  })

  test('a named drizzle .prepare() statement is prepared', async () => {
    const { db, outer, close } = build()
    try {
      const statement = db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, sql.placeholder('id')))
        .prepare('workspace_by_id')
      await statement.execute({ id: 'w1' })
      expect(outer.map((entry) => entry.prepared)).toEqual([true])
    } finally {
      await close()
    }
  })

  test('statements in a transaction and a nested savepoint are prepared on the scoped client', async () => {
    const { db, outer, scoped, close } = build()
    try {
      await db.transaction(async (tx) => {
        await tx.select().from(workspaces).where(eq(workspaces.id, 'w1'))
        await tx.execute(sql`select 1`)
        await tx.transaction(async (nested) => {
          await nested.execute(sql`select 2`)
        })
      })
      expect(outer).toEqual([])
      expect(scoped.length).toBe(3)
      for (const statement of scoped) expect(statement.prepared).toBe(true)
    } finally {
      await close()
    }
  })

  test('a declared transaction-pooled origin stays unprepared on every path', async () => {
    const outer: Statement[] = []
    const scoped: Statement[] = []
    const { client, db } = createDatabase(HOSTED, { preparedStatements: false })
    const scope = postgres(HOSTED, databaseConnectionOptions({ preparedStatements: false }))
    record(client, outer)
    record(scope, scoped)
    stubScopes(client, scope)
    const close = async () => {
      await client.end({ timeout: 0 })
      await scope.end({ timeout: 0 })
    }
    try {
      await db.execute(sql`select 1`)
      await db.transaction(async (tx) => {
        await tx.execute(sql`select 2`)
      })
      expect([...outer, ...scoped].map((entry) => entry.prepared)).toEqual([false, false])
    } finally {
      await close()
    }
  })

  test('control: stock drizzle over a prepare: true client still sends unprepared statements', async () => {
    // This is the defect the wrapper fixes. If it stops reproducing, drizzle changed `unsafe()`
    // and the wrapper should be re-read against it.
    const client = postgres(HOSTED, { prepare: true })
    const recorded: Statement[] = []
    record(client, recorded)
    try {
      await drizzle(client, { schema }).execute(sql`select 1`)
      expect(recorded.map((entry) => entry.prepared)).toEqual([false])
    } finally {
      await client.end({ timeout: 0 })
    }
  })

  test('the wrapper leaves the client and its cache posture alone', async () => {
    const { client, db, close } = createDatabase(HOSTED)
    try {
      expect((db as unknown as { $client: unknown }).$client).toBe(client)
      expect((db as unknown as { $cache: unknown }).$cache).toBeUndefined()
      const session = (db as unknown as { session: { options: unknown } }).session
      expect(session.options).toEqual({ logger: undefined, cache: undefined })
    } finally {
      await close()
    }
  })
})
