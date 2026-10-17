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

export function createDatabase(connectionUrl = readDatabaseUrl()) {
  const client = postgres(connectionUrl, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 20,
    prepare: false,
  })

  return {
    client,
    db: constructDatabase(client),
    close: () => client.end({ timeout: 5 }),
  }
}

export type DatabaseConnection = ReturnType<typeof createDatabase>
export type AgentHqDatabase = DatabaseConnection['db']
export type AgentHqTransaction = Parameters<Parameters<AgentHqDatabase['transaction']>[0]>[0]
