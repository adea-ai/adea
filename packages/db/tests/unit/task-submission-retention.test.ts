import { expect, test } from 'bun:test'

import type { AgentHqDatabase } from '../../src/connection'
import {
  inspectExpiredTaskSubmissionCiphertext,
  purgeExpiredTaskSubmissionCiphertext,
} from '../../src/task-submission-retention'

test('retention refuses unscoped or unbounded work before touching the database', async () => {
  const database = {} as AgentHqDatabase
  const workspaceId = '550e8400-e29b-41d4-a716-446655440000'
  for (const operation of [
    inspectExpiredTaskSubmissionCiphertext,
    purgeExpiredTaskSubmissionCiphertext,
  ]) {
    await expect(operation(database, 'PRIVATE_INVALID_SCOPE_SENTINEL', 1)).rejects.toThrow(
      'Invalid task submission retention scope or limit'
    )
    for (const limit of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(operation(database, workspaceId, limit)).rejects.toThrow(
        'Invalid task submission retention scope or limit'
      )
    }
  }
})

function recordingRetentionDatabase(results: unknown[][], failAt = -1) {
  const calls: import('drizzle-orm').SQL[] = []
  let transactions = 0
  const database = {
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      transactions++
      return operation({
        execute: async (query: import('drizzle-orm').SQL) => {
          calls.push(query)
          if (calls.length === failAt) throw new Error('synthetic-retention-failure')
          return results[calls.length - 1] ?? []
        },
      })
    },
  } as unknown as AgentHqDatabase
  return { database, calls, transactions: () => transactions }
}

test('preview uses bounded database time and reports counts without changing rows', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core')
  const fixture = recordingRetentionDatabase([[], [], [{ count: '7' }]])
  const workspaceId = '550e8400-e29b-41d4-a716-446655440000'
  expect(await inspectExpiredTaskSubmissionCiphertext(fixture.database, workspaceId, 7)).toBe(7)
  expect(fixture.transactions()).toBe(1)
  const queries = fixture.calls.map((query) => new PgDialect().sqlToQuery(query))
  expect(queries[0]?.sql).toBe("set local statement_timeout = '5s'")
  expect(queries[1]?.sql).toBe("set local lock_timeout = '1s'")
  expect(queries[2]?.params).toEqual([workspaceId, 7])
  expect(queries[2]?.sql).toContain('submission.expires_at <= statement_timestamp()')
  expect(queries[2]?.sql).toContain("outbox.command_type = 'task.submit'")
  expect(queries[2]?.sql).not.toMatch(/update|delete/i)
  expect(
    await inspectExpiredTaskSubmissionCiphertext(
      recordingRetentionDatabase([]).database,
      workspaceId
    )
  ).toBe(0)
})

test('purge counts returned intents and retains a scoped skip-locked atomic update', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core')
  const fixture = recordingRetentionDatabase([[], [], [{ id: 'one' }, { id: 'two' }]])
  const workspaceId = '550e8400-e29b-41d4-a716-446655440000'
  expect(await purgeExpiredTaskSubmissionCiphertext(fixture.database, workspaceId)).toBe(2)
  expect(fixture.transactions()).toBe(1)
  const query = new PgDialect().sqlToQuery(fixture.calls[2]!)
  expect(query.params).toEqual([workspaceId, 1000, workspaceId, workspaceId])
  expect(query.sql).toContain('for update of submission, outbox skip locked')
  expect(query.sql).toContain("outbox.payload - 'envelope'")
  expect(query.sql).toContain('ciphertext_purged_at = statement_timestamp()')
  expect(query.sql).not.toMatch(/delete from/i)
  expect(
    await purgeExpiredTaskSubmissionCiphertext(
      recordingRetentionDatabase([]).database,
      workspaceId,
      1
    )
  ).toBe(0)
})

test('retention propagates a timeout or query failure without further work', async () => {
  for (const operation of [
    inspectExpiredTaskSubmissionCiphertext,
    purgeExpiredTaskSubmissionCiphertext,
  ]) {
    for (const failAt of [1, 2, 3]) {
      const fixture = recordingRetentionDatabase([], failAt)
      await expect(
        operation(fixture.database, '550e8400-e29b-41d4-a716-446655440000', 1)
      ).rejects.toThrow('synthetic-retention-failure')
      expect(fixture.calls).toHaveLength(failAt)
    }
  }
})
