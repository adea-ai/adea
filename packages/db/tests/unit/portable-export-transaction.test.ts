import { describe, expect, test } from 'bun:test'

import { PORTABLE_EXPORT_TRANSACTION_CONFIG } from '../../src/portable-export-transaction'

describe('portable export transaction', () => {
  test('runs READ COMMITTED in READ WRITE mode, so the canonical readers can take their share locks', () => {
    // A READ ONLY transaction refuses `FOR SHARE` (SQLSTATE 25006), which the authority readers
    // use. READ WRITE is needed for that and nothing else: the export issues no writes.
    expect(PORTABLE_EXPORT_TRANSACTION_CONFIG).toEqual({
      accessMode: 'read write',
      isolationLevel: 'read committed',
    })
  })
})
