import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'

import { createDatabase } from '../../src/connection'

// The ORM path must send parameterized statements as named prepared statements: Postgres.js
// builds drizzle's `client.unsafe()` calls unprepared by default, and Cloudflare documents that
// unprepared parameterized statements are unreliable under Hyperdrive transaction pooling while
// named prepared statements from Postgres.js are supported. These tests run against the real
// disposable PostgreSQL the integration lane provisions and read `pg_prepared_statements`, which
// lists the named statements of the current session. A single connection keeps that view complete.
// Hyperdrive itself is not part of this lane: see the pull request for the live-qualification gate.

const connectionUrl = process.env.DATABASE_URL
const probe = pgTable('prepared_statement_probe', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
})

type Named = { statement: string; types: string }

describe.skipIf(!connectionUrl)('drizzle statements are named prepared statements', () => {
  const { client, db, close } = createDatabase(connectionUrl!, { maxConnections: 1 })

  async function named(like: string): Promise<Named[]> {
    const rows = await client.unsafe(
      'select statement, parameter_types::text as types from pg_prepared_statements where statement ilike $1 order by statement',
      [like],
      { prepare: false }
    )
    return rows.map((row) => ({ statement: String(row.statement), types: String(row.types) }))
  }

  beforeAll(async () => {
    await client.unsafe('drop table if exists prepared_statement_probe')
    await client.unsafe(
      'create table prepared_statement_probe (id integer primary key, label text not null)'
    )
  })

  afterAll(async () => {
    await client.unsafe('drop table if exists prepared_statement_probe').catch(() => undefined)
    await close()
  })

  test('the driver is prepared for a direct local connection', () => {
    expect((client.options as { prepare: boolean }).prepare).toBe(true)
  })

  test('raw SQL with a parameter is a named prepared statement', async () => {
    const rows = await db.execute(sql`select ${7}::integer as seven, 'raw-probe' as tag`)
    expect(Array.from(rows as unknown as Array<{ seven: number }>)[0]?.seven).toBe(7)
    expect(await named('%raw-probe%')).toEqual([
      { statement: expect.stringContaining('raw-probe'), types: '{integer}' },
    ])
  })

  test('drizzle and the documented tagged-template call share one prepared statement', async () => {
    const like = 'select id, label from prepared_statement_probe%'
    await db.execute(sql`select id, label from prepared_statement_probe where id = ${1}`)
    expect(await named(like)).toHaveLength(1)
    await client`select id, label from prepared_statement_probe where id = ${1}`
    expect(await named(like)).toHaveLength(1)
  })

  test('parameterized builder statements are prepared and return the right rows', async () => {
    await db.insert(probe).values({ id: 10, label: 'ten' })
    await db.update(probe).set({ label: 'TEN' }).where(eq(probe.id, 10))
    const rows = await db.select().from(probe).where(eq(probe.id, 10))
    expect(rows).toEqual([{ id: 10, label: 'TEN' }])
    const statements = (await named('%"prepared_statement_probe"%')).map(
      (entry) => entry.statement.split(' ')[0]
    )
    expect(statements).toEqual(expect.arrayContaining(['insert', 'update', 'select']))
  })

  test('relational queries are prepared', async () => {
    const rows = await db.query.workspaces.findMany({ columns: { id: true }, limit: 1 })
    expect(rows).toBeArray()
    expect(await named('%from "app"."workspaces"%')).not.toHaveLength(0)
  })

  test('a named drizzle prepare() statement executes repeatedly', async () => {
    const byId = db
      .select()
      .from(probe)
      .where(eq(probe.id, sql.placeholder('id')))
      .prepare('probe_by_id')
    expect(await byId.execute({ id: 10 })).toEqual([{ id: 10, label: 'TEN' }])
    expect(await byId.execute({ id: 11 })).toEqual([])
  })

  test('transactions commit and roll back with prepared statements', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(probe).values({ id: 20, label: 'committed' })
      expect(await tx.select().from(probe).where(eq(probe.id, 20))).toHaveLength(1)
    })
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(probe).values({ id: 21, label: 'rolled-back' })
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')

    expect(await db.select().from(probe).where(eq(probe.id, 20))).toHaveLength(1)
    expect(await db.select().from(probe).where(eq(probe.id, 21))).toHaveLength(0)
  })

  test('a nested savepoint rolls back alone while the outer transaction commits', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(probe).values({ id: 30, label: 'outer' })
      await expect(
        tx.transaction(async (nested) => {
          await nested.insert(probe).values({ id: 31, label: 'inner' })
          expect(await nested.select().from(probe).where(eq(probe.id, 31))).toHaveLength(1)
          throw new Error('abort inner')
        })
      ).rejects.toThrow('abort inner')
      await tx.transaction(async (nested) => {
        await nested.insert(probe).values({ id: 32, label: 'inner-kept' })
      })
    })

    const ids = (await db.select().from(probe)).map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining([30, 32]))
    expect(ids).not.toContain(31)
  })

  test('statements inside a transaction are prepared on the same connection', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select ${5}::integer as five, 'tx-probe' as tag`)
      await tx.transaction(async (nested) => {
        await nested.execute(sql`select ${6}::integer as six, 'savepoint-probe' as tag`)
      })
    })
    expect(await named('%tx-probe%')).toHaveLength(1)
    expect(await named('%savepoint-probe%')).toHaveLength(1)
  })

  test('migration-style multi-statement SQL without parameters still runs', async () => {
    await db.execute(
      sql.raw(
        'create temp table prepared_probe_temp (n integer); insert into prepared_probe_temp values (1); drop table prepared_probe_temp'
      )
    )
  })
})
