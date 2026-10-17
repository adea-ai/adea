import { describe, expect, test } from 'bun:test'
import { npmVersion as drizzleVersion } from 'drizzle-orm/version'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { createDatabase } from '../../src/connection'
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
      // Closing one request's client must not touch the other's.
      await first.close()
      expect((second.client as unknown as { options: { max: number } }).options.max).toBe(10)
    } finally {
      await first.close()
      await second.close()
    }
  })
})
