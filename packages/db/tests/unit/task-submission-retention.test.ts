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
