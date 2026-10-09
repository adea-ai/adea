import { describe, expect, test } from 'bun:test'
import {
  parseRequestedRoleModelSelections,
  sameRequestedRoleModelSelections,
} from '../../src/lead-model-selections'
const lead = { selectionRef: `msel_${'a'.repeat(32)}`, selectionRevision: 1 }
const child = { selectionRef: `msel_${'b'.repeat(32)}`, selectionRevision: 2 }
describe('canonical requested role model choices', () => {
  test('omission preserves defaults and explicit child never inherits lead', () => {
    expect(parseRequestedRoleModelSelections(undefined)).toBeUndefined()
    expect(parseRequestedRoleModelSelections({ lead })).toEqual({ lead })
    expect(parseRequestedRoleModelSelections({ child })).toEqual({ child })
    const both = parseRequestedRoleModelSelections({ child, lead })!
    expect(both).toEqual({ lead, child })
    expect(Object.isFrozen(both)).toBe(true)
    expect(Object.isFrozen(both.lead)).toBe(true)
  })
  test('exact choices replay across key order and changes conflict', () => {
    expect(sameRequestedRoleModelSelections({ lead, child }, { child, lead })).toBe(true)
    expect(sameRequestedRoleModelSelections(undefined, { lead })).toBe(false)
    expect(
      sameRequestedRoleModelSelections({ lead }, { lead: { ...lead, selectionRevision: 2 } })
    ).toBe(false)
    expect(sameRequestedRoleModelSelections({ lead }, { lead: child })).toBe(false)
    expect(sameRequestedRoleModelSelections({ lead }, { child: lead })).toBe(false)
  })
  test('rejects empty roles, snapshots, auth, missing pins and unsafe revisions', () => {
    for (const input of [
      null,
      {},
      [],
      { direct: lead },
      { lead: null },
      { lead: { ...lead, secret: 'canary' } },
      { lead: { ...lead, selectionRevision: 0 } },
      { lead: { ...lead, selectionRevision: 1.5 } },
      { lead: { ...lead, selectionRevision: Number.MAX_SAFE_INTEGER + 1 } },
      { lead: { selectionRef: lead.selectionRef } },
      { lead: { ...lead, selectionRef: 'mconn_' + 'a'.repeat(32) } },
    ])
      expect(() => parseRequestedRoleModelSelections(input)).toThrow(
        'Invalid requested model selections'
      )
  })
})
