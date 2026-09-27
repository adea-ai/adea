import { expect, test } from 'bun:test'

import * as runtime from '../src/dev-runtime'
import * as errors from '../src/dev-runtime-errors'

test('the narrow errors module preserves the canonical Dev Runtime error exports', () => {
  expect(errors.devErrorCodes).toBe(runtime.devErrorCodes)
  expect(errors.devErrorCodes).toContain('stale_generation')
  expect(errors.devErrorCodes).toContain('delivery_ambiguous')
})
