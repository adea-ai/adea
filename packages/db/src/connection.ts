import {
  createTableRelationsHelpers,
  type ExtractTablesWithRelations,
  extractTablesRelationalConfig,
  type RelationalSchemaConfig,
} from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session'
import postgres, { type Sql } from 'postgres'

import { readDatabaseUrl } from './config'
import * as schema from './schema'

type AppSchema = typeof schema
type AppRelationalSchema = RelationalSchemaConfig<ExtractTablesWithRelations<AppSchema>>

// drizzle() re-derives the relational config of the whole schema on every call: a walk over every
// table, column and relation. On a Worker that opens a database client per request, that was about
// 1.2 ms of the roughly 11 ms of isolate CPU an account request costs. The derived config is static
// metadata computed from code (tables and relations): it holds no client, credential, principal or
// request data, and the query builders only read it. Each request still gets its own client, dialect
// and session, so only this immutable description is shared.
let relationalSchema: AppRelationalSchema | undefined

function sharedRelationalSchema(): AppRelationalSchema {
  if (relationalSchema) return relationalSchema
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers)
  relationalSchema = {
    fullSchema: schema,
    schema: tablesConfig.tables as AppRelationalSchema['schema'],
    tableNamesMap: tablesConfig.tableNamesMap,
  }
  return relationalSchema
}

const transparentParser = (value: unknown) => value

/**
 * Builds the same database object as `drizzle(client, { schema })` from drizzle-orm 0.45.3
 * (`postgres-js/driver.js`, `construct`) with the schema config shared instead of re-derived. The
 * parser and serializer setup below is that function's, verbatim; the test in
 * tests/unit/connection.test.ts compares the two constructions and fails when drizzle-orm changes
 * so this is re-read against the new `construct`.
 */
function constructDatabase(client: Sql) {
  const options = client.options as unknown as {
    parsers: Record<string, unknown>
    serializers: Record<string, unknown>
  }
  for (const type of ['1184', '1082', '1083', '1114', '1182', '1185', '1115', '1231']) {
    options.parsers[type] = transparentParser
    options.serializers[type] = transparentParser
  }
  options.serializers['114'] = transparentParser
  options.serializers['3802'] = transparentParser

  const dialect = new PgDialect({ casing: undefined })
  const relational = sharedRelationalSchema()
  const session = new PostgresJsSession(client, dialect, relational, {
    logger: undefined,
    cache: undefined,
  })
  const db = new PostgresJsDatabase(
    dialect,
    session,
    relational
  ) as PostgresJsDatabase<AppSchema> & {
    $client: Sql
  }
  db.$client = client
  // drizzle assigns the configured cache here, which is undefined: this client configures none.
  ;(db as { $cache: unknown }).$cache = undefined
  return db
}

// A Worker request holds one short-lived client whose connections all go through
// Hyperdrive (or a pooler), which owns the origin pool: a handful of edge
// connections is enough, and Cloudflare's own Postgres.js example caps a Worker
// client at 5. A long-lived Node server pools directly against PostgreSQL and
// keeps the previous ceiling.
const WORKERS_MAX_CONNECTIONS = 5
const SERVER_MAX_CONNECTIONS = 10
const WORKERS_USER_AGENT = 'Cloudflare-Workers'

function isWorkersRuntime(): boolean {
  return globalThis.navigator?.userAgent === WORKERS_USER_AGENT
}

/**
 * Driver tuning for one connection URL, split out so it can be asserted without
 * opening a socket.
 *
 * `prepare` is `false` for every connection role. It is only a default: drizzle's
 * postgres-js session executes every statement, including those inside
 * `transaction()` and savepoints, through `client.unsafe(query, params)`, and
 * Postgres.js builds those queries with `prepare: false`, so the ORM path never
 * names a prepared statement regardless of this option. Setting it here keeps a
 * query issued directly on `client` (a tagged template) on the same footing,
 * which is what a transaction-pooled endpoint (Cloudflare Hyperdrive, PgBouncer)
 * needs. The unit tests exercise the real drizzle-to-driver path to keep this
 * honest; whether Hyperdrive itself caches or pools as expected is a cutover
 * gate checked against a live binding, not here. No `cache` option is set: the
 * drizzle database below owns `$cache: undefined`, and no database-level query
 * cache backs auth, session or permission reads.
 */
export interface CreateDatabaseOptions {
  maxConnections?: number
  connectTimeoutSeconds?: number
  idleTimeoutSeconds?: number
}

export function databaseConnectionOptions(options: CreateDatabaseOptions = {}): {
  max: number
  connect_timeout: number
  idle_timeout: number
  prepare: false
} {
  return {
    max:
      options.maxConnections ??
      (isWorkersRuntime() ? WORKERS_MAX_CONNECTIONS : SERVER_MAX_CONNECTIONS),
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    prepare: false,
  }
}

export function createDatabase(
  connectionUrl = readDatabaseUrl(),
  options: CreateDatabaseOptions = {}
) {
  const client = postgres(connectionUrl, databaseConnectionOptions(options))

  return {
    client,
    db: constructDatabase(client),
    close: () => client.end({ timeout: 5 }),
  }
}

export type DatabaseConnection = ReturnType<typeof createDatabase>
export type AgentHqDatabase = DatabaseConnection['db']
export type AgentHqTransaction = Parameters<Parameters<AgentHqDatabase['transaction']>[0]>[0]
