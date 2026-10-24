/**
 * `text[]` array type registration: characterization and proof.
 *
 * The application schema has exactly one array column, `tasks.artifact_refs` (`text[]`,
 * PostgreSQL OID 1009, element OID 25). Postgres.js discovers the array OIDs of the whole
 * database on every new connection and registers a parser for each one. That discovery is
 * one `pg_catalog.pg_type` round trip per connection, and the application opens a fresh
 * client per request.
 *
 * This file characterizes what happens when that discovery is switched off
 * (`fetch_types: false`) and proves the one registration strategy that keeps the values
 * Drizzle returns identical to the production behaviour.
 *
 * The mechanism, in the pinned driver versions:
 *
 * - `postgres@3.4.9` returns a raw PostgreSQL array literal when no parser is registered
 *   for the column OID (a column whose `column.parser` is `undefined` is read as a string).
 * - `drizzle-orm@0.45.3` then parses that string itself (`PgArray.mapFromDriverValue` ->
 *   `parsePgArray`), and that parser removes every backslash from every element:
 *   `arrayString.slice(...).replace(/\\/g, "")`.
 * - With the production default (`fetch_types: true`) Postgres.js registers its own array
 *   parser, the driver value is already a JavaScript array, and Drizzle never enters
 *   `parsePgArray` — so no backslash is lost.
 *
 * A `fetch_types: false` client is therefore only safe when the array OID carries a parser
 * that returns a JavaScript array. The only such parser available without duplicating a
 * driver internal is the one Postgres.js itself registers during its discovery, so the
 * proof copies it from a discovery client instead of reimplementing it.
 *
 * Nothing in the production code path is changed by this file. It is a test and a proof.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PgArray, PgTable } from 'drizzle-orm/pg-core'
import postgres, { type Sql } from 'postgres'

import {
  createDatabase,
  databaseConnectionOptions,
  type DatabaseConnection,
} from '../../src/connection'
import * as schema from '../../src/schema'
import { tasks } from '../../src/schema'
import { createTemporaryUserSession } from '../../src/identity'
import { createTask, getTaskForUser } from '../../src/tasks'
import { createWorkspaceWithOwner } from '../../src/workspaces'

const connectionUrl = process.env.DATABASE_URL

/** PostgreSQL `text[]` and its element type. Both are built-in OIDs, stable across majors. */
const TEXT_OID = 25
const TEXT_ARRAY_OID = 1009

/**
 * The driver options this test reads and writes. `postgres` does not publish the type of
 * its internal options object, so the test names the parts it uses.
 */
type DriverOptions = {
  debug?: unknown
  parsers: Record<string, ((value: never) => unknown) & { array?: boolean }>
  serializers: Record<string, (value: never) => unknown>
  shared: { retries: number; typeArrayMap: Record<number, number> }
}

function driverOptions(client: Sql): DriverOptions {
  return client.options as unknown as DriverOptions
}

/** Counts the `pg_catalog.pg_type` discovery a client issues. */
function countCatalogQueries(client: Sql): () => number {
  let count = 0
  // The driver reads `options.debug` when it sends a statement, so the hook can be
  // attached to a client that already exists.
  driverOptions(client).debug = (_id: unknown, statement: string) => {
    if (statement.includes('pg_catalog.pg_type')) count += 1
  }
  return () => count
}

/**
 * The values the matrix covers. Every one of them is a value the product write path
 * accepts (`createTask` trims and rejects empty references).
 */
const MATRIX: ReadonlyArray<{ name: string; refs: readonly string[] }> = [
  { name: 'simple', refs: ['simple'] },
  { name: 'backslash', refs: ['back\\slash'] },
  { name: 'double backslash', refs: ['double\\\\backslash'] },
  { name: 'trailing backslash', refs: ['trailing\\'] },
  { name: 'windows path', refs: ['C:\\Users\\test\\file.txt'] },
  { name: 'double quotes', refs: ['with "double" quotes'] },
  { name: 'single quotes', refs: ["with 'single' quotes"] },
  { name: 'comma', refs: ['comma,inside'] },
  { name: 'braces', refs: ['brace{inside}'] },
  { name: 'closing brace', refs: ['a}b'] },
  { name: 'brace pair', refs: ['{braces}'] },
  { name: 'unicode', refs: ['unicode: é中文🚀'] },
  { name: 'newline', refs: ['line1\nline2'] },
  { name: 'tab', refs: ['a\tb'] },
  { name: 'json like', refs: ['{"json":"like"}'] },
  { name: 'everything combined', refs: ['a"b\\c,d{e}f'] },
  { name: 'backslash before quote', refs: ['back\\"quote'] },
]

/**
 * Values only a direct write can produce, read back through the same driver path.
 *
 * `expected` is the value the driver returns for the literal, written out so a
 * comparison never passes by matching two absent rows or by matching one absent row
 * against `undefined`. A PostgreSQL NULL element reaches the driver as the unquoted
 * word `NULL`, which is what the driver turns into a string element.
 */
const DIRECT_MATRIX: ReadonlyArray<{
  name: string
  literal: string
  expected: readonly string[]
}> = [
  { name: 'empty array', literal: '{}', expected: [] },
  { name: 'empty string element', literal: '{""}', expected: [''] },
  { name: 'null element', literal: '{NULL}', expected: ['NULL'] },
  { name: 'null between elements', literal: '{"a",NULL,"b"}', expected: ['a', 'NULL', 'b'] },
  { name: 'null only', literal: '{NULL,NULL}', expected: ['NULL', 'NULL'] },
]

type ExperimentalClient = Readonly<{
  client: Sql
  db: ReturnType<typeof drizzle>
  catalogQueries: () => number
}>

/**
 * The artifact references of a read, by row title, together with the titles that appear
 * more than once. A comparison over this map cannot pass by matching two absent rows,
 * because the expected titles are asserted against it before the comparison runs.
 */
function indexArtifactRefsByTitle(rows: ReadonlyArray<unknown>): {
  byTitle: Map<string, unknown>
  duplicatedTitles: string[]
} {
  const byTitle = new Map<string, unknown>()
  const counts = new Map<string, number>()
  for (const row of rows) {
    const title = (row as { title: string }).title
    byTitle.set(title, (row as { artifactRefs: unknown }).artifactRefs)
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  return {
    byTitle,
    duplicatedTitles: [...counts].filter(([, count]) => count > 1).map(([title]) => title),
  }
}

/** The titles the comparison expects that the read did not return. */
function missingTitles(
  expected: readonly string[],
  byTitle: ReadonlyMap<string, unknown>
): string[] {
  return expected.filter((title) => !byTitle.has(title))
}

/**
 * A client with the discovery switched off and no array parser registered. This is what
 * `fetch_types: false` produces on its own, and it is the shape that loses backslashes.
 */
function clientWithoutArrayParser(url: string): ExperimentalClient {
  const client = postgres(url, { ...databaseConnectionOptions(), fetch_types: false })
  const catalogQueries = countCatalogQueries(client)
  return { client, db: drizzle(client, { schema }), catalogQueries }
}

/**
 * The seams the failure-path coverage needs. The helper opens two clients, so a test has
 * to be able to observe them and to make the registration fail on purpose.
 */
type RegisteredArrayParserOptions = {
  /** The array OID the driver is expected to have registered. Defaults to `text[]`. */
  expectedArrayOid?: number
  /** The application name the clients announce, so a test can find their sessions. */
  applicationName?: string
  /** Closes a client. Defaults to the driver's own `end`. */
  closeClient?: (client: Sql) => Promise<void>
  /** Called with every client the helper opens, in the order it opens them. */
  onClient?: (client: Sql) => void
}

/**
 * Closes a client without ever replacing the error that caused the cleanup.
 */
async function closeQuietly(
  closeClient: (client: Sql) => Promise<void>,
  client: Sql
): Promise<void> {
  try {
    await closeClient(client)
  } catch {
    // The primary error is what the caller needs to see, so a cleanup failure is dropped.
  }
}

/**
 * A client with the discovery switched off and the array OID registered with the parser
 * Postgres.js itself installs during its discovery. The parser is copied from a discovery
 * client rather than reimplemented, so the driver stays the single owner of the array
 * format.
 *
 * The helper opens two clients. The discovery client is closed on every path, and a
 * recipient client that was opened before a failure is closed as well, so a failed
 * registration leaves no socket behind. The error that caused the failure is the one the
 * caller sees: a cleanup failure never replaces it.
 */
async function clientWithRegisteredArrayParser(
  url: string,
  options: RegisteredArrayParserOptions = {}
): Promise<ExperimentalClient> {
  const {
    applicationName,
    closeClient = (client: Sql) => client.end({ timeout: 2 }),
    expectedArrayOid = TEXT_ARRAY_OID,
    onClient,
  } = options
  const clientOptions = {
    ...databaseConnectionOptions(),
    ...(applicationName ? { connection: { application_name: applicationName } } : {}),
  }
  let discovery: Sql | undefined
  let client: Sql | undefined
  let failed = false
  try {
    discovery = postgres(url, { ...clientOptions })
    onClient?.(discovery)
    await discovery`select 1`
    client = postgres(url, { ...clientOptions, fetch_types: false })
    onClient?.(client)
    const discovered = driverOptions(discovery)
    const arrayOid = discovered.shared.typeArrayMap[TEXT_OID]
    const parser = discovered.parsers[arrayOid]
    const serializer = discovered.serializers[arrayOid]
    if (arrayOid !== expectedArrayOid || !parser || !serializer) {
      throw new Error(`The driver did not register a parser for text[] (${arrayOid})`)
    }
    const target = driverOptions(client)
    target.parsers[arrayOid] = parser
    target.serializers[arrayOid] = serializer
    target.shared.typeArrayMap[TEXT_OID] = arrayOid
    const catalogQueries = countCatalogQueries(client)
    return { client, db: drizzle(client, { schema }), catalogQueries }
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (discovery) await closeQuietly(closeClient, discovery)
    // A recipient client that was opened before the failure is closed as well. The
    // successful path returns it to the caller instead.
    if (client && failed) await closeQuietly(closeClient, client)
  }
}

describe.skipIf(!connectionUrl)('text[] array type registration', () => {
  let production: DatabaseConnection
  let workspaceId: string
  let principal: Awaited<ReturnType<typeof createTemporaryUserSession>>['principal']
  const taskIdsByCase = new Map<string, string>()

  beforeAll(async () => {
    production = createDatabase(connectionUrl!)
    const owner = await createTemporaryUserSession(production.db, {
      credentialDigest: `array-type-owner-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    principal = owner.principal
    const created = await createWorkspaceWithOwner(production.db, {
      idempotencyKey: `array-type-${crypto.randomUUID()}`,
      name: 'Array Type',
      owner: principal,
    })
    workspaceId = created.workspace.id
    for (const testCase of MATRIX) {
      const task = await createTask(
        production.db,
        workspaceId,
        principal,
        {
          artifactRefs: testCase.refs,
          objective: 'Array type registration',
          title: `array-type-${testCase.name}`,
        },
        {
          correlationId: `array-type:${testCase.name}`,
          idempotencyKey: `array-type:${testCase.name}:${crypto.randomUUID()}`,
          requestId: crypto.randomUUID(),
        }
      )
      taskIdsByCase.set(testCase.name, task.id)
    }
  })

  afterAll(async () => {
    await production.close()
  })

  /** The value the production client returns for every case, through the product read. */
  async function productionValues(): Promise<Map<string, unknown>> {
    const values = new Map<string, unknown>()
    const unresolved: string[] = []
    for (const testCase of MATRIX) {
      const taskId = taskIdsByCase.get(testCase.name)!
      const summary = await getTaskForUser(production.db, workspaceId, taskId, principal)
      // A task that is not readable is a failure, not an undefined value to compare.
      if (!summary) {
        unresolved.push(testCase.name)
        continue
      }
      values.set(testCase.name, summary.artifactRefs)
    }
    expect(unresolved).toEqual([])
    return values
  }

  /** The same read through an experimental client: the portable-export read shape. */
  async function experimentalValues(db: ReturnType<typeof drizzle>): Promise<Map<string, unknown>> {
    const rows = await db.select().from(tasks).where(eq(tasks.workspaceId, workspaceId))
    const { byTitle, duplicatedTitles } = indexArtifactRefsByTitle(rows)
    const titles = MATRIX.map((testCase) => `array-type-${testCase.name}`)
    // The rows have to be there, and each of them exactly once, before any comparison.
    expect(missingTitles(titles, byTitle)).toEqual([])
    expect(duplicatedTitles).toEqual([])
    const values = new Map<string, unknown>()
    for (const testCase of MATRIX) {
      values.set(testCase.name, byTitle.get(`array-type-${testCase.name}`))
    }
    return values
  }

  /** The server sessions the given application name currently has. */
  async function countSessions(applicationName: string): Promise<number> {
    const rows = (await production.client.unsafe(
      `select count(*)::int as count from pg_stat_activity where application_name = $1`,
      [applicationName]
    )) as unknown as Array<{ count: number }>
    return Number(rows[0]?.count ?? 0)
  }

  /**
   * Waits for the server to notice that the sessions of an application name are gone.
   * The backend ends when it reads the closed socket, so the row can outlive the close
   * call by a moment.
   */
  async function waitForNoSessions(applicationName: string): Promise<number> {
    let remaining = await countSessions(applicationName)
    for (let attempt = 0; attempt < 40 && remaining > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      remaining = await countSessions(applicationName)
    }
    return remaining
  }

  test('the production client returns the artifact references unchanged', async () => {
    const values = await productionValues()
    for (const testCase of MATRIX) {
      // The explicit expected value: the product write path stores the references as
      // given, so the read has to return exactly that.
      expect(values.get(testCase.name)).toEqual(testCase.refs)
    }
    expect(values.get('backslash')).toEqual(['back\\slash'])
    expect(values.get('windows path')).toEqual(['C:\\Users\\test\\file.txt'])
    expect(values.get('everything combined')).toEqual(['a"b\\c,d{e}f'])
  })

  test('the production client issues one array-type catalog query per connection', async () => {
    const client = postgres(connectionUrl!, { ...databaseConnectionOptions() })
    const catalogQueries = countCatalogQueries(client)
    try {
      await client`select 1`
      expect(catalogQueries()).toBe(1)
    } finally {
      await client.end({ timeout: 2 })
    }
  })

  test('switching the discovery off without registering the array OID loses backslashes', async () => {
    const experimental = clientWithoutArrayParser(connectionUrl!)
    try {
      const values = await experimentalValues(experimental.db)
      const expected = await productionValues()
      // The defect, characterized: Drizzle parses the raw literal itself and its parser
      // removes every backslash. The value is wrong, and it is wrong silently.
      expect(values.get('backslash')).toEqual(['backslash'])
      expect(values.get('windows path')).toEqual(['C:Userstestfile.txt'])
      expect(values.get('backslash')).not.toEqual(expected.get('backslash'))
      // The failure is confined to the values that carry a backslash.
      expect(values.get('simple')).toEqual(expected.get('simple'))
      expect(values.get('unicode')).toEqual(expected.get('unicode'))
    } finally {
      await experimental.client.end({ timeout: 2 })
    }
  })

  test('registering the array OID with the driver parser keeps every value', async () => {
    const experimental = await clientWithRegisteredArrayParser(connectionUrl!)
    try {
      const values = await experimentalValues(experimental.db)
      const expected = await productionValues()
      for (const testCase of MATRIX) {
        // The explicit expected value first, then the two reads agreeing on it.
        expect(values.get(testCase.name)).toEqual(testCase.refs)
        expect(expected.get(testCase.name)).toEqual(testCase.refs)
        expect(values.get(testCase.name)).toEqual(expected.get(testCase.name))
      }
      // The registered client never asks the server for the array catalog.
      expect(experimental.catalogQueries()).toBe(0)
    } finally {
      await experimental.client.end({ timeout: 2 })
    }
  })

  test('the registered parser carries the driver array marker', async () => {
    const experimental = await clientWithRegisteredArrayParser(connectionUrl!)
    try {
      const parser = driverOptions(experimental.client).parsers[TEXT_ARRAY_OID]
      expect(parser.array).toBe(true)
    } finally {
      await experimental.client.end({ timeout: 2 })
    }
  })

  test('the schema declares exactly one array column and it is the registered OID', async () => {
    const arrayColumns: string[] = []
    for (const value of Object.values(schema)) {
      if (!(value instanceof PgTable)) continue
      const named = value as unknown as Record<symbol, string>
      const columns = named[Symbol.for('drizzle:Columns')] as unknown as Record<string, unknown>
      for (const column of Object.values(columns)) {
        if (column instanceof PgArray) {
          arrayColumns.push(`${named[Symbol.for('drizzle:Name')]}.${column.name}`)
        }
      }
    }
    expect(arrayColumns).toEqual(['tasks.artifact_refs'])
    const rows = (await production.client.unsafe(
      `select t.oid, t.typname from pg_type t where t.typname = '_text'`
    )) as unknown as Array<{ oid: number; typname: string }>
    expect(rows[0]?.oid).toBe(TEXT_ARRAY_OID)
    expect(rows[0]?.typname).toBe('_text')
  })

  test('values only a direct write can produce are read back identically', async () => {
    const writer = postgres(connectionUrl!, { max: 1 })
    try {
      for (const testCase of DIRECT_MATRIX) {
        const inserted = await writer.unsafe(
          `insert into app.tasks (workspace_id, creator_user_id, title, objective, artifact_refs) select id, owner_user_id, $2, 'direct write', $3::text[] from app.workspaces where id = $1`,
          [workspaceId, `array-type-direct-${testCase.name}`, testCase.literal]
        )
        // The write selects the workspace row, so it can insert nothing. One inserted row
        // per case is the precondition for the comparison below.
        expect(Number(inserted.count)).toBe(1)
      }
    } finally {
      await writer.end({ timeout: 2 })
    }
    const experimental = await clientWithRegisteredArrayParser(connectionUrl!)
    try {
      const rows = await experimental.db
        .select()
        .from(tasks)
        .where(eq(tasks.workspaceId, workspaceId))
      const { byTitle, duplicatedTitles } = indexArtifactRefsByTitle(rows)
      const productionRows = await production.db
        .select()
        .from(tasks)
        .where(eq(tasks.workspaceId, workspaceId))
      const { byTitle: productionByTitle, duplicatedTitles: productionDuplicates } =
        indexArtifactRefsByTitle(productionRows)
      const titles = DIRECT_MATRIX.map((testCase) => `array-type-direct-${testCase.name}`)
      // The rows have to be there, and each of them exactly once, before any comparison.
      expect(missingTitles(titles, byTitle)).toEqual([])
      expect(missingTitles(titles, productionByTitle)).toEqual([])
      expect(duplicatedTitles).toEqual([])
      expect(productionDuplicates).toEqual([])
      for (const testCase of DIRECT_MATRIX) {
        const title = `array-type-direct-${testCase.name}`
        // The explicit expected value, and then the two reads agreeing on it.
        expect(byTitle.get(title)).toEqual(testCase.expected)
        expect(productionByTitle.get(title)).toEqual(testCase.expected)
        expect(byTitle.get(title)).toEqual(productionByTitle.get(title))
      }
    } finally {
      await experimental.client.end({ timeout: 2 })
    }
  })

  test('a failed registration closes every client it opened', async () => {
    const opened: Sql[] = []
    const closed: Sql[] = []
    const sessionsBeforeClose: number[] = []
    const applicationName = `array-type-failure-${crypto.randomUUID()}`
    const failure = await clientWithRegisteredArrayParser(connectionUrl!, {
      // The driver registers text[] and not this OID, so the validation fails after the
      // recipient client has been opened.
      expectedArrayOid: 4242,
      applicationName,
      closeClient: async (client) => {
        sessionsBeforeClose.push(await countSessions(applicationName))
        closed.push(client)
        await client.end({ timeout: 2 })
      },
      onClient: (client) => opened.push(client),
    }).then(
      () => undefined,
      (error: Error) => error
    )
    expect(failure?.message).toContain('did not register a parser for text[]')
    // The discovery client and the recipient client were both opened, and both are closed.
    expect(opened.length).toBe(2)
    expect(closed.length).toBe(2)
    expect(new Set(closed)).toEqual(new Set(opened))
    // The discovery client had a live server session before the cleanup, and the session
    // is gone afterwards: the socket was closed, not just the driver object.
    expect(sessionsBeforeClose.some((count) => count > 0)).toBe(true)
    expect(await waitForNoSessions(applicationName)).toBe(0)
  })

  test('a discovery that cannot connect closes its client and keeps the connection error', async () => {
    const opened: Sql[] = []
    const closed: Sql[] = []
    const failure = await clientWithRegisteredArrayParser(
      'postgresql://app:secret@127.0.0.1:1/none?sslmode=disable',
      {
        closeClient: async (client) => {
          closed.push(client)
          await client.end({ timeout: 2 })
        },
        onClient: (client) => opened.push(client),
      }
    ).then(
      () => undefined,
      (error: Error) => error
    )
    // The connection error is the one the caller sees, not a cleanup error.
    expect(failure?.message).toContain('ECONNREFUSED')
    expect(opened.length).toBe(1)
    expect(closed).toEqual(opened)
  })

  test('a cleanup failure never replaces the error that caused it', async () => {
    const failure = await clientWithRegisteredArrayParser(connectionUrl!, {
      expectedArrayOid: 4242,
      closeClient: async (client) => {
        await client.end({ timeout: 2 })
        throw new Error('the close failed')
      },
    }).then(
      () => undefined,
      (error: Error) => error
    )
    expect(failure?.message).toContain('did not register a parser for text[]')
    expect(failure?.message).not.toContain('the close failed')
  })
})
