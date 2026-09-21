import { describe, expect, test } from 'bun:test'

import {
  announcementForMove,
  moveIdInOrder,
  moveIdRelativeTo,
  reorderGroups,
  reorderGroupsRelativeTo,
  reorderProjects,
  reorderProjectsRelativeTo,
  type SidebarGroup,
} from '../src/sidebar/reorder'

const groups: SidebarGroup[] = [
  { id: 'g1', name: 'Product', projects: [{ id: 'p1' }, { id: 'p2' }] },
  { id: 'g2', name: 'Platform', projects: [{ id: 'p3' }] },
]

describe('sidebar reorder model', () => {
  test('moving a group up swaps it with its predecessor', () => {
    expect(reorderGroups(groups, 'g2', 'up').map((group) => group.id)).toEqual(['g2', 'g1'])
  })

  test('moving a group down swaps it with its successor', () => {
    expect(reorderGroups(groups, 'g1', 'down').map((group) => group.id)).toEqual(['g2', 'g1'])
  })

  test('moves at the boundary are a no-op, not a wrap', () => {
    expect(reorderGroups(groups, 'g1', 'up')).toBe(groups)
    expect(reorderGroups(groups, 'g2', 'down')).toBe(groups)
  })

  test('an unknown group id is a no-op', () => {
    expect(reorderGroups(groups, 'ghost', 'up')).toBe(groups)
  })

  test('reordering projects inside one group leaves the other groups untouched', () => {
    const nested: SidebarGroup[] = [
      { id: 'g1', name: 'A', projects: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] },
      { id: 'g2', name: 'B', projects: [{ id: 'p9' }] },
    ]
    const next = reorderProjects(nested, 'g1', 'p2', 'down')
    expect(next[0]!.projects.map((project) => project.id)).toEqual(['p1', 'p3', 'p2'])
    expect(next[1]).toBe(nested[1])
  })

  test('reordering projects in an unknown group is a no-op', () => {
    expect(reorderProjects(groups, 'ghost', 'p1', 'up')).toBe(groups)
  })

  test('moveIdInOrder exposes the pure order mutation for the runtime command', () => {
    expect(moveIdInOrder(['a', 'b', 'c'], 'c', 'up')).toEqual(['a', 'c', 'b'])
    expect(moveIdInOrder(['a', 'b', 'c'], 'a', 'up')).toBeUndefined()
    expect(moveIdInOrder(['a', 'b', 'c'], 'b', 'down')).toEqual(['a', 'c', 'b'])
  })

  test('pointer drops place the dragged id before its target', () => {
    expect(moveIdRelativeTo(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveIdRelativeTo(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c'])
    // Dropping on itself, or on an unknown target, is a no-op.
    expect(moveIdRelativeTo(['a', 'b', 'c'], 'b', 'b')).toBeUndefined()
    expect(moveIdRelativeTo(['a', 'b', 'c'], 'a', 'ghost')).toBeUndefined()
  })

  test('group drops reuse the same pure placement', () => {
    const next = reorderGroupsRelativeTo(groups, 'g2', 'g1')
    expect(next.map((group) => group.id)).toEqual(['g2', 'g1'])
    expect(reorderGroupsRelativeTo(groups, 'g1', 'g1')).toBe(groups)
  })

  test('project drops stay inside their group', () => {
    const nested: SidebarGroup[] = [
      { id: 'g1', name: 'A', projects: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] },
    ]
    const next = reorderProjectsRelativeTo(nested, 'g1', 'p3', 'p1')
    expect(next[0]!.projects.map((project) => project.id)).toEqual(['p3', 'p1', 'p2'])
    expect(reorderProjectsRelativeTo(nested, 'ghost', 'p1', 'p2')).toBe(nested)
  })

  test('announcements name the item and its new position for screen readers', () => {
    expect(announcementForMove('Platform', 1, 2, true)).toBe('Platform moved to position 1 of 2')
    expect(announcementForMove('Runtime tools', 2, 3, true)).toBe(
      'Runtime tools moved to position 2 of 3'
    )
    // A no-op boundary move is announced instead of staying silent.
    expect(announcementForMove('Product', 1, 2, false)).toBe(
      'Product is already at position 1 of 2'
    )
  })
})
