import { describe, expect, test } from 'bun:test'

import type { JanitorItem } from '@adea-ai/types/dev-runtime'

import {
  janitorMeasureIds,
  janitorSections,
  janitorSelectionSummary,
  JANITOR_DISPOSAL_LABELS,
  JANITOR_MEASURE_WINDOW,
  JANITOR_SECTION_ORDER,
  JANITOR_SECTION_TITLES,
} from '../src/resources/janitor-view-model'

const item = (
  overrides: Partial<JanitorItem> & Pick<JanitorItem, 'id' | 'section'>
): JanitorItem => ({
  label: overrides.id,
  pathLabel: `~/junk/${overrides.id}`,
  state: 'measured',
  disposal: 'trash',
  observedAt: '2026-10-06T09:20:00.000Z',
  ...overrides,
})

describe('janitor view model', () => {
  test('sections group in display order and skip empty ones', () => {
    const sections = janitorSections([
      item({ id: 'a', section: 'trash', bytes: '10' }),
      item({ id: 'b', section: 'derived_data', bytes: '5' }),
      item({ id: 'c', section: 'derived_data', bytes: '7' }),
      item({ id: 'd', section: 'worktree' as JanitorItem['section'], bytes: '1' }),
    ])
    expect(sections.map((section) => section.id)).toEqual(['derived_data', 'worktree', 'trash'])
    expect(sections[0]?.totalBytes).toBe(12)
    expect(sections[1]?.title).toBe('Git worktrees')
  })

  test('a section with any unmeasured item has no total, never a partial one', () => {
    const sections = janitorSections([
      item({ id: 'a', section: 'cache', bytes: '5' }),
      item({ id: 'b', section: 'cache', state: 'discovered' }),
    ])
    expect(sections[0]?.totalBytes).toBeUndefined()
    expect(sections[0]?.items).toHaveLength(2)
  })

  test('the selection summary names the count, the total, and permanence', () => {
    const trashOnly = janitorSelectionSummary([
      item({ id: 'a', section: 'derived_data', bytes: '100' }),
      item({ id: 'b', section: 'cache', bytes: '23' }),
    ])
    expect(trashOnly).toEqual({ count: 2, totalBytes: 123, permanent: false })
    const withEmpty = janitorSelectionSummary([
      item({ id: 't', section: 'trash', disposal: 'trash_empty', bytes: '4' }),
    ])
    expect(withEmpty.permanent).toBe(true)
    const unmeasured = janitorSelectionSummary([item({ id: 'u', section: 'cache' })])
    expect(unmeasured.totalBytes).toBeUndefined()
    expect(unmeasured.count).toBe(1)
  })

  test('the measure window asks only for undiscovered or stale items, bounded', () => {
    const items = Array.from({ length: JANITOR_MEASURE_WINDOW + 10 }, (_, index) =>
      item({ id: `jn-${index}`, section: 'cache', state: 'discovered' })
    )
    const withMeasured = [
      item({ id: 'stale', section: 'cache', state: 'stale' }),
      item({ id: 'done', section: 'cache', state: 'measured' }),
      ...items,
    ]
    const ids = janitorMeasureIds(withMeasured)
    expect(ids).toHaveLength(JANITOR_MEASURE_WINDOW)
    expect(ids).not.toContain('done')
    expect(ids[0]).toBe('stale')
  })

  test('every disposal and section has a display label', () => {
    for (const section of JANITOR_SECTION_ORDER) {
      expect(JANITOR_SECTION_TITLES[section]).toBeTruthy()
    }
    for (const disposal of Object.keys(JANITOR_DISPOSAL_LABELS)) {
      expect(JANITOR_DISPOSAL_LABELS[disposal as JanitorItem['disposal']]).toBeTruthy()
    }
  })
})
