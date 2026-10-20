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

type StatementOptions = Parameters<Sql['unsafe']>[2]

/**
 * drizzle's postgres-js session executes every statement as `client.unsafe(sql, params)`, and
 * Postgres.js builds an `unsafe()` query with `prepare: false` unless the call says otherwise. So
 * with the client's own `prepare: true`, which is what Cloudflare documents for Hyperdrive, the ORM
 * path would still send every builder, relational, raw and transaction statement unprepared, and
 * Cloudflare warns that unprepared statements "can cause queries to hang or fail intermittently"
 * under Hyperdrive transaction pooling. This view of the client asks for `prepare: true` on each
 * `unsafe()` call, and does the same for the clients `begin()` and `savepoint()` hand to their
 * callbacks, which is where drizzle runs transaction statements. Nothing else about the client
 * changes: the same connection pool, parsers and `end()` back it, and `db.$client` stays the real
 * client.
 */
function preparedStatementView(client: Sql): Sql {
  const scoped =
    (method: 'begin' | 'savepoint') =>
    (...args: unknown[]) => {
      const callback = args.pop() as (scope: Sql) => unknown
      const target = (
        client as unknown as Record<typeof method, (...parameters: unknown[]) => unknown>
      )[method]
      return target.call(client, ...args, (scope: Sql) => callback(preparedStatementView(scope)))
    }
  const unsafe = (query: string, parameters?: unknown[], options?: StatementOptions) =>
    client.unsafe(query, parameters as never, { prepare: true, ...options })

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'unsafe') return unsafe
      if (property === 'begin' || property === 'savepoint') return scoped(property)
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Builds the same database object as `drizzle(client, { schema })` from drizzle-orm 0.45.3
 * (`postgres-js/driver.js`, `construct`) with the schema config shared instead of re-derived. The
 * parser and serializer setup below is that function's, verbatim; the test in
 * tests/unit/connection.test.ts compares the two constructions and fails when drizzle-orm changes
 * so this is re-read against the new `construct`.
 */
function constructDatabase(client: Sql, prepareStatements: boolean) {
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
  const session = new PostgresJsSession(
    prepareStatements ? preparedStatementView(client) : client,
    dialect,
    relational,
    {
      logger: undefined,
      cache: undefined,
    }
  )
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
 * Driver tuning for one database connection, split out so it can be asserted
 * without opening a socket.
 *
 * `prepare` is true for every connection this deployment can open. Cloudflare
 * documents `prepare: true` for Hyperdrive and warns that `prepare: false` can
 * hang or fail under its transaction pooling, and a direct managed PostgreSQL
 * connection prepares statements too. The transaction-pooled endpoint shape that
 * required the unprepared mode belonged to the provider this deployment has
 * left, so there is no longer a hosted host to detect and exempt; a host name
 * is not a statement-capability contract. If a deployment ever needs a
 * transaction-pooled origin, it must declare that explicitly here rather than be
 * inferred from a hostname. The option alone does not reach the ORM (see
 * `preparedStatementView`), so `createDatabase` also applies it to the drizzle
 * session. No `cache` option is set: the drizzle database below owns
 * `$cache: undefined`, and no database-level query cache backs auth, session or
 * permission reads. Hyperdrive's own query cache is configured on the Hyperdrive
 * binding, outside this package.
 */
export interface CreateDatabaseOptions {
  maxConnections?: number
  connectTimeoutSeconds?: number
  idleTimeoutSeconds?: number
  /** Defaults to true. Only a declared transaction-pooled origin may turn it off. */
  preparedStatements?: boolean
}

export function databaseConnectionOptions(options: CreateDatabaseOptions = {}): {
  max: number
  connect_timeout: number
  idle_timeout: number
  prepare: boolean
} {
  return {
    max:
      options.maxConnections ??
      (isWorkersRuntime() ? WORKERS_MAX_CONNECTIONS : SERVER_MAX_CONNECTIONS),
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    prepare: options.preparedStatements ?? true,
  }
}

export function createDatabase(
  connectionUrl = readDatabaseUrl(),
  options: CreateDatabaseOptions = {}
) {
  const driverOptions = databaseConnectionOptions(options)
  const client = postgres(connectionUrl, driverOptions)

  return {
    client,
    db: constructDatabase(client, driverOptions.prepare),
    close: () => client.end({ timeout: 5 }),
  }
}

export type DatabaseConnection = ReturnType<typeof createDatabase>
export type AgentHqDatabase = DatabaseConnection['db']
export type AgentHqTransaction = Parameters<Parameters<AgentHqDatabase['transaction']>[0]>[0]
