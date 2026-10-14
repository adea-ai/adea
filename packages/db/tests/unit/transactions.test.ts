import { describe, expect, test } from 'bun:test'

import type { AgentHqTransaction } from '../../src/connection'
import { inReadSnapshot } from '../../src/transactions'

function transactionWithIsolation(isolationLevel: string): AgentHqTransaction {
  return {
    execute: async () => [{ isolationLevel }],
    rollback: () => undefined,
  } as unknown as AgentHqTransaction
}

describe('inReadSnapshot', () => {
  test('rejects a caller-owned READ COMMITTED transaction before invoking the reader', async () => {
    const transaction = transactionWithIsolation('read committed')
    let invoked = false

    await expect(
      inReadSnapshot(transaction, async () => {
        invoked = true
        return 'read result'
      })
    ).rejects.toThrow('REPEATABLE READ or SERIALIZABLE')

    expect(invoked).toBe(false)
  })

  for (const isolationLevel of ['repeatable read', 'serializable']) {
    test(`reuses a caller-owned ${isolationLevel.toUpperCase()} transaction`, async () => {
      const transaction = transactionWithIsolation(isolationLevel)

      await expect(inReadSnapshot(transaction, async (existing) => existing)).resolves.toBe(
        transaction
      )
    })
  }
})
