import { expect, test } from 'bun:test'
import { cn } from '../src/lib/utils'

test('private compatibility imports honor shared design-system token overrides', () => {
  expect(cn('h-control-md', 'h-control-sm')).toBe('h-control-sm')
  expect(cn('w-sidebar', 'w-sidebar-compact')).toBe('w-sidebar-compact')
  expect(cn('size-control-lg', 'size-control-sm')).toBe('size-control-sm')
  expect(cn('p-2', { 'p-4': true, hidden: false }, 'global-hook')).toBe('p-4 global-hook')
})
