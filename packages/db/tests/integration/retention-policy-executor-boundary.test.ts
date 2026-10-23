import { describe, expect, test } from 'bun:test'

import { runRetentionCleanupExecutor } from '../../src/retention-cleanup-executor'
import { RetentionPolicyError } from '../../src/retention-policy'

// The real executor imports the database boundary. Keep its rejection proof in
// the required integration inventory; pure policy coverage stays in the unit lane.
const INHERITED_PROPERTY_NAMES = [
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
] as const

const ANCHOR = '2026-01-01T00:00:00.000Z'
const SUBJECT = 'fixture-policy-subject'
const EXECUTOR = 'fixture-policy-executor'

describe('the cleanup executor refuses an undefined policy before it reaches a store', () => {
  test('an inherited category name is refused with a typed code, without a database', async () => {
    for (const name of INHERITED_PROPERTY_NAMES) {
      let raised: unknown
      try {
        // The database is a stub the executor never reaches: it refuses the
        // category before it looks at a store, a subject or a transaction.
        await runRetentionCleanupExecutor({} as never, {
          anchorAt: ANCHOR,
          category: name as never,
          coverageInventory: {},
          executorId: EXECUTOR,
          reconciliationOpen: false,
          stores: [],
          subjectId: SUBJECT,
          submit: async () => {},
          workspaceId: '00000000-0000-4000-8000-000000000000',
        })
      } catch (error) {
        raised = error
      }
      expect(raised).toBeInstanceOf(RetentionPolicyError)
      expect((raised as RetentionPolicyError).code).toBe('invalid_candidate')
    }
  })
})
