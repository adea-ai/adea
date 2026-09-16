import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

const SOURCE_ROOTS = [
  'apps/web/src',
  'packages/app-core/src',
  'packages/audio/src',
  'packages/data/src',
  'packages/dev-view/src',
  'packages/state/src',
  'packages/ui/src',
  'packages/workspace-ui/src',
]

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  if (!existsSync(directory)) return files
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && /\.(tsx?|mts|cts|mjs|cjs|jsx?)$/.test(entry.name)) files.push(path)
  }
  return files
}

// React migration residue that must not come back: the Next.js client
// directive (dead code pretending a module boundary that does not exist in
// Solid/TanStack Start) and React-era imports the lint boundary also rejects.
const DIRECTIVE = /^(?:'use client'|"use client")\s*;?\s*$/m
const REACT_IMPORT = /from\s+['"](?:react|react-dom|next)(?:\/[^'"]*)?['"]/

describe('react artifacts boundary', () => {
  test('no Solid source file carries the React/Next "use client" directive', () => {
    const offenders = SOURCE_ROOTS.flatMap((directory) =>
      sourceFiles(join(root, directory)).filter((file) =>
        DIRECTIVE.test(readFileSync(file, 'utf8'))
      )
    )
    expect(offenders.map((file) => file.slice(root.length + 1))).toEqual([])
  })

  test('no Solid source file imports React or Next modules', () => {
    const offenders = SOURCE_ROOTS.flatMap((directory) =>
      sourceFiles(join(root, directory)).filter((file) =>
        REACT_IMPORT.test(readFileSync(file, 'utf8'))
      )
    )
    expect(offenders.map((file) => file.slice(root.length + 1))).toEqual([])
  })
})
