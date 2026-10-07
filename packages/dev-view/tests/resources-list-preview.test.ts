import { describe, expect, test } from 'bun:test'

import { listPreview, LIST_PREVIEW_LIMIT } from '../src/resources/resources-view-model'

const rows = (count: number) => Array.from({ length: count }, (_, index) => `row-${index}`)

describe('resources section list preview (show-more)', () => {
  test('a section at or under the limit never collapses', () => {
    for (const count of [0, 1, LIST_PREVIEW_LIMIT]) {
      const preview = listPreview(rows(count), false)
      expect(preview.visible).toHaveLength(count)
      expect(preview.hidden).toBe(0)
      expect(preview.expanded).toBe(count > 0)
    }
  })

  test('a section over the limit shows the first 8 rows and hides the rest', () => {
    const preview = listPreview(rows(13), false)
    expect(preview.visible).toEqual(rows(8))
    expect(preview.visible).toHaveLength(LIST_PREVIEW_LIMIT)
    expect(preview.hidden).toBe(5)
    expect(preview.expanded).toBe(false)
  })

  test('an expanded section shows everything with nothing hidden', () => {
    const items = rows(13)
    const preview = listPreview(items, true)
    expect(preview.visible).toEqual(items)
    expect(preview.hidden).toBe(0)
    expect(preview.expanded).toBe(true)
  })

  test('a custom limit bounds the collapsed window', () => {
    const preview = listPreview(rows(5), false, 2)
    expect(preview.visible).toEqual(['row-0', 'row-1'])
    expect(preview.hidden).toBe(3)
  })
})
