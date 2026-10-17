import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createDatabase } from '../../src/connection'

// createDatabase shares only immutable schema metadata. Closing one call's client, as the request
// scope does when a request ends, must leave every other call's database fully usable.

const connectionUrl = process.env.DATABASE_URL
const opened: Array<ReturnType<typeof createDatabase>> = []

function open() {
  const connection = createDatabase(connectionUrl!)
  opened.push(connection)
  return connection
}

afterAll(async () => {
  await Promise.all(opened.map((connection) => connection.close().catch(() => undefined)))
})

describe.skipIf(!connectionUrl)('createDatabase request isolation', () => {
  test('a second database keeps answering queries after the first is closed', async () => {
    const first = open()
    const second = open()
    const before = await Promise.all([
      first.db.execute(sql`SELECT 1 AS one`),
      second.db.execute(sql`SELECT 2 AS two`),
    ])
    expect(Array.from(before[0] as unknown as Array<{ one: number }>)[0]?.one).toBe(1)
    expect(Array.from(before[1] as unknown as Array<{ two: number }>)[0]?.two).toBe(2)

    await first.close()

    const after = await second.db.execute(sql`SELECT 3 AS three`)
    expect(Array.from(after as unknown as Array<{ three: number }>)[0]?.three).toBe(3)
  })

  test('relational queries on a new database work while another is closed', async () => {
    const closed = open()
    await closed.close()
    const live = open()
    expect(await live.db.query.workspaces.findMany({ columns: { id: true }, limit: 1 })).toBeArray()
  })
})
