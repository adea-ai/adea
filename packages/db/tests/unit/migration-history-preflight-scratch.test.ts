import { describe, expect, test } from 'bun:test'
import {
  cleanupScratchDatabase,
  throwScratchFailures,
  type ScratchDatabaseAdmin,
} from '../integration/migration-history-preflight-scratch'

describe('migration history preflight scratch cleanup', () => {
  test('reports failed cleanup steps and verifies whether the database remains', async () => {
    const calls: string[] = []
    const terminateError = new Error('termination failed')
    const dropError = new Error('drop failed')
    const admin: ScratchDatabaseAdmin = {
      async unsafe(query) {
        calls.push(query)
        if (query.includes('pg_terminate_backend')) throw terminateError
        if (query.startsWith('DROP DATABASE')) throw dropError
        if (query.includes('pg_database')) return [{ exists: true }]
        return []
      },
    }

    let cleanupError: unknown
    try {
      await cleanupScratchDatabase(admin, 'migration_preflight_test')
    } catch (error) {
      cleanupError = error
    }

    expect(cleanupError).toBeInstanceOf(AggregateError)
    expect((cleanupError as AggregateError).errors).toEqual([
      terminateError,
      dropError,
      expect.objectContaining({ message: expect.stringMatching(/still exists/i) }),
    ])
    expect(calls.some((query) => query.includes('pg_terminate_backend'))).toBe(true)
    expect(calls.some((query) => query.startsWith('DROP DATABASE'))).toBe(true)
    expect(calls.some((query) => query.includes('pg_database'))).toBe(true)
  })

  test('preserves the original scratch body error when cleanup also fails', () => {
    const bodyError = new Error('migration assertion failed')
    const cleanupError = new AggregateError([new Error('drop failed')], 'scratch cleanup failed')
    let thrown: unknown
    try {
      throwScratchFailures(true, bodyError, [cleanupError])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).cause).toBe(bodyError)
    expect((thrown as AggregateError).errors[0]).toBe(bodyError)
    expect((thrown as AggregateError).errors[1]).toBe(cleanupError)
  })

  test('rethrows the original scratch body error when cleanup succeeds', () => {
    const bodyError = new Error('migration assertion failed')
    let thrown: unknown
    try {
      throwScratchFailures(true, bodyError, [])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(bodyError)
  })
})
