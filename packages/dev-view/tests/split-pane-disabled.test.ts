import { describe, expect, test } from 'bun:test'

import { MAX_LAYOUT_LEAVES, splitPaneDisabled } from '../src/layout/operations'

describe('splitPaneDisabled', () => {
  test('is disabled while no project is selected, regardless of leaf count', () => {
    expect(splitPaneDisabled(1, '')).toBe(true)
    expect(splitPaneDisabled(4, '')).toBe(true)
  })

  test('is enabled once a project is selected and the layout is under the cap', () => {
    expect(splitPaneDisabled(1, 'proj-1')).toBe(false)
    expect(splitPaneDisabled(MAX_LAYOUT_LEAVES - 1, 'proj-1')).toBe(false)
  })

  test('keeps the shared leaf cap', () => {
    expect(splitPaneDisabled(MAX_LAYOUT_LEAVES, 'proj-1')).toBe(true)
    expect(splitPaneDisabled(MAX_LAYOUT_LEAVES + 2, 'proj-1')).toBe(true)
  })
})
