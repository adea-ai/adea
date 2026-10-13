import { describe, expect, test } from 'bun:test'

import { themeRecords, variantFromRecord } from '@adea-ai/ui/lib/themes'

import { importedVariantFromRecord } from '../src/components/imported-theme-variant'

// The host copy exists only to keep the 34-theme table out of the start-up chunk
// (ADR 0014). It must stay the published projection, value for value.
describe('imported theme variant', () => {
  test('matches the published variantFromRecord for every catalogue record', () => {
    for (const record of themeRecords) {
      expect(importedVariantFromRecord(record)).toEqual(variantFromRecord(record))
    }
  })
})
