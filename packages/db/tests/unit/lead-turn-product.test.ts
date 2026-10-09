import { expect, test } from 'bun:test'
import { isLeadTurnProductSelector } from '../../src/lead-turn-product-selectors'

test('product reader selectors accept canonical CP workspace/intent identities without caller authority', () => {
  const workspaceId = `wsp_${'0'.repeat(26)}`
  const intentId = '71c81b04-9304-40aa-81c8-12b75b5fba58'
  expect(isLeadTurnProductSelector(workspaceId, intentId)).toBe(true)
  expect(isLeadTurnProductSelector(workspaceId, intentId.toUpperCase())).toBe(true)
  for (const invalid of [
    '',
    'user:owner',
    '550e8400-e29b-41d4-a716-446655440000',
    `wsp_${'I'.repeat(26)}`,
  ]) {
    expect(isLeadTurnProductSelector(invalid, intentId)).toBe(false)
  }
  for (const invalid of [
    '',
    'intent:owner',
    'not-a-uuid',
    '71c81b04-9304-00aa-81c8-12b75b5fba58',
  ]) {
    expect(isLeadTurnProductSelector(workspaceId, invalid)).toBe(false)
  }
})
