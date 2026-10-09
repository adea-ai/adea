import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Management routing boundary (#1215): the human HTTP controls and the lead
 * tool host must reach management mutations through the shared gateway, never
 * by importing the database function directly. `management-composition.ts` is
 * the one sanctioned binding site.
 */
const MANAGEMENT_DB_FUNCTIONS = new Set([
  'archiveProject',
  'archiveWorkspace',
  'createProject',
  'removeProjectMember',
  'reopenWorkspace',
  'reorderProjects',
  'reorderWorkspaces',
  'setProjectMember',
  'setProjectVisibility',
  'softDeleteProject',
  'updateProject',
  'updateWorkspace',
])

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : Promise.resolve([path])
    })
  )
  return files.flat()
}

function importedDbFunctions(source: string): string[] {
  // Value imports only: a `import type` binding is erased at runtime and is the
  // sanctioned way for an executor module to stay test-injectable.
  return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@adea-ai\/db'/g)].flatMap((match) =>
    match[1]!
      .split(',')
      .map((name) =>
        name
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim()
      )
      .filter(Boolean)
  )
}

describe('management routing boundary (#1215)', () => {
  test('no API route imports a management database function directly', async () => {
    const routes = await filesUnder(join(import.meta.dir, '../src/start/routes/api'))
    const violations: string[] = []
    for (const file of routes.filter((path) => path.endsWith('.ts'))) {
      const source = await readFile(file, 'utf8')
      for (const imported of importedDbFunctions(source))
        if (MANAGEMENT_DB_FUNCTIONS.has(imported))
          violations.push(`${relative(join(import.meta.dir, '..'), file)}: ${imported}`)
    }
    // The sole exception is the caller's own workspace ordering, a per-user
    // personal preference that is deliberately not a workspace management
    // action. Any other direct call is a regression.
    expect(violations.toSorted()).toEqual([
      'src/start/routes/api/workspaces/reorder.ts: reorderWorkspaces',
    ])
  })

  test('the lead tool surface imports the shared operations, never the database', async () => {
    const source = await readFile(
      join(import.meta.dir, '../src/server/lead-management-tools.ts'),
      'utf8'
    )
    expect(importedDbFunctions(source)).toEqual([])
    expect(source).toContain("from './management-operations'")
    expect(source).toContain("from './management-gateway'")
  })

  test('the shared operations stay database-type-only so unit tests can inject fakes', async () => {
    const source = await readFile(
      join(import.meta.dir, '../src/server/management-operations.ts'),
      'utf8'
    )
    expect(importedDbFunctions(source)).toEqual([])
    expect(source).toContain("import type { AgentHqDatabase } from '@adea-ai/db'")
  })

  test('the only direct management database binding is the composition module', async () => {
    const source = await readFile(
      join(import.meta.dir, '../src/server/management-composition.ts'),
      'utf8'
    )
    for (const fn of ['archiveProject', 'createProject', 'softDeleteProject', 'updateProject'])
      expect(source).toContain(fn)
  })
})
