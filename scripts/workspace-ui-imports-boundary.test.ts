import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  if (!existsSync(directory)) return files
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && /\.(tsx?|mts|cts)$/.test(entry.name)) files.push(path)
  }
  return files
}

// The workspace-ui barrel re-exports every module in the package, including
// the dialogs and the conventional shell. A runtime import of one symbol pulls
// the whole re-export graph into the importing chunk's static dependency list
// — which is exactly how the plugins and settings dialogs ended up preloaded
// at startup. Subpath imports (@adea-ai/workspace-ui/<module>) keep each
// chunk's graph shallow; type-only barrel imports erase at compile time and
// are harmless.
const RUNTIME_BARREL = /^import\s+(?!type\b)[^;\n]*from\s+['"]@adea-ai\/workspace-ui['"]/m
const DYNAMIC_BARREL = /import\(\s*['"]@adea-ai\/workspace-ui['"]\s*\)/

describe('workspace-ui import boundary', () => {
  test('apps/web uses subpath imports, never the runtime barrel', () => {
    const offenders = sourceFiles(join(root, 'apps/web/src')).filter((file) => {
      const source = readFileSync(file, 'utf8')
      return RUNTIME_BARREL.test(source) || DYNAMIC_BARREL.test(source)
    })
    expect(offenders.map((file) => file.slice(root.length + 1))).toEqual([])
  })

  test('packages never reach apps through the runtime barrel', () => {
    const offenders = ['packages/workspace-ui/src', 'packages/dev-view/src'].flatMap((directory) =>
      sourceFiles(join(root, directory)).filter((file) =>
        RUNTIME_BARREL.test(readFileSync(file, 'utf8'))
      )
    )
    expect(offenders.map((file) => file.slice(root.length + 1))).toEqual([])
  })
})
