import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'

import type { AgentHqDatabase } from '../../src/connection'

/**
 * A narrow test double for the drizzle calls the Sim stores make. It records every statement in the
 * order it was issued and answers each one from a caller-supplied function, so a unit test can
 * assert ordering, locking and branching without a database. It proves nothing about what
 * PostgreSQL does with those statements; the integration suites do that against a real database.
 */
export type Step = { name: string; args: unknown[] }
export type Statement = {
  op: 'select' | 'insert' | 'update' | 'delete'
  table: unknown
  steps: Step[]
}
export type Entry =
  | Statement
  | { op: 'execute'; sql: string; params: unknown[] }
  | { op: 'transaction' | 'commit' | 'rollback' }

const dialect = new PgDialect()

/** The text and parameters drizzle would send for a `sql` template or a condition. */
export const renderSql = (query: unknown) => dialect.sqlToQuery(query as never)

/** The first step with this name on a statement, or undefined. */
export const stepOf = (statement: Statement, name: string) =>
  statement.steps.find((step) => step.name === name)

export function recordingDatabase(rows: (statement: Statement) => unknown[] | Error = () => []): {
  database: AgentHqDatabase
  log: Entry[]
} {
  const log: Entry[] = []

  const statement = (op: Statement['op'], table: unknown) => {
    const entry: Statement = { op, table, steps: [] }
    log.push(entry)
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, name) {
          if (name === 'then') {
            return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => {
              const answer = rows(entry)
              if (answer instanceof Error) reject(answer)
              else resolve(answer)
            }
          }
          return (...args: unknown[]) => {
            entry.steps.push({ name: String(name), args })
            return chain
          }
        },
      }
    )
    return chain
  }

  const database = {
    select: () => ({ from: (table: unknown) => statement('select', table) }),
    insert: (table: unknown) => statement('insert', table),
    update: (table: unknown) => statement('update', table),
    delete: (table: unknown) => statement('delete', table),
    async execute(query: unknown) {
      const { sql, params } = renderSql(query)
      log.push({ op: 'execute', sql, params })
      return []
    },
    async transaction(callback: (inner: unknown) => Promise<unknown>) {
      log.push({ op: 'transaction' })
      try {
        const result = await callback(database)
        log.push({ op: 'commit' })
        return result
      } catch (error) {
        log.push({ op: 'rollback' })
        throw error
      }
    },
  }
  return { database: database as unknown as AgentHqDatabase, log }
}

/** The log as short strings, such as `update sim_launch_codes` or `select workspaces +for`. */
export function trace(log: readonly Entry[]): string[] {
  return log.map((entry) => {
    if (entry.op === 'execute') return `execute ${entry.sql}`
    if (entry.op === 'transaction' || entry.op === 'commit' || entry.op === 'rollback')
      return entry.op
    const name = getTableConfig(entry.table as never).name
    return `${entry.op} ${name}${stepOf(entry, 'for') ? ' +for' : ''}`
  })
}
