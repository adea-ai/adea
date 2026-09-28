import { expect, test } from 'bun:test'
import { cn } from '../src/lib/utils'

test('private compatibility imports honor shared design-system token overrides', () => {
  // These are class-merger input fixtures from the published token namespace,
  // not rendered app markup; the app linter reads only its local theme schema.
  /* oxlint-disable shadcn/no-unknown-classes */
  expect(cn('h-control-md', 'h-control-sm')).toBe('h-control-sm')
  expect(cn('w-sidebar', 'w-sidebar-compact')).toBe('w-sidebar-compact')
  expect(cn('size-control-lg', 'size-control-sm')).toBe('size-control-sm')
  /* oxlint-enable shadcn/no-unknown-classes */
  expect(cn('p-2', { 'p-4': true, hidden: false }, 'global-hook')).toBe('p-4 global-hook')
})
