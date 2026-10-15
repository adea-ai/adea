import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = join(import.meta.dir, '../../src')
const files = readdirSync(source).filter((name) => /\.tsx?$/.test(name))
const staticImports = (target: string) =>
  files.filter((name) => {
    const text = readFileSync(join(source, name), 'utf8')
    return new RegExp(`^import (?!type\\b)[^;']*?from '\\./${target}'`, 'm').test(text)
  })

// Chat's initial graph is the shell and everything it imports statically. The
// board and the task panel load on demand, so nothing may import them with a
// static value import; type-only imports are erased and stay allowed.
test('nothing statically imports the task board or the task panel implementation', () => {
  expect(staticImports('task-board')).toEqual([])
  expect(staticImports('task-detail')).toEqual([])
})

test('the Tasks surface loads the board, and the board loads the panel, on demand', () => {
  expect(readFileSync(join(source, 'task-board-surface.tsx'), 'utf8')).toContain(
    "import('./task-board')"
  )
  expect(readFileSync(join(source, 'task-board.tsx'), 'utf8')).toContain("import('./task-detail')")
  expect(readFileSync(join(source, 'conventional-workspace-shell.tsx'), 'utf8')).toContain(
    "from './task-board-surface'"
  )
})

test('the background lease helper stays a non-UI module the board can import', () => {
  const lease = readFileSync(join(source, 'task-background-lease.ts'), 'utf8')
  expect(lease).not.toMatch(/from '(solid-js|\.\/task-)/)
})
