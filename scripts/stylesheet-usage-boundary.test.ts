import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

function filesUnder(directory: string, extension: RegExp): string[] {
  const files: string[] = []
  if (!existsSync(directory)) return files
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path, extension))
    else if (entry.isFile() && extension.test(entry.name)) files.push(path)
  }
  return files
}

const sourceRoots = [
  'apps/web/src',
  'packages/dev-view/src',
  'packages/ui/src/components',
  'packages/workspace-ui/src',
]
const source = sourceRoots
  .flatMap((directory) => filesUnder(join(root, directory), /\.tsx?$/))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')

// Template-constructed class prefixes, e.g. `conventional-message--${kind}`.
// Any defined selector sharing the prefix counts as used.
const dynamicPrefixes = [...source.matchAll(/([a-z][a-z0-9_-]*--?)\$\{/g)].map(
  ([, prefix]) => prefix
)

const projectPrefixes = [
  'conventional-',
  'dev-',
  'global-',
  'plugin-',
  'plugins-',
  'virtual-',
  'workspace-',
  'visually-hidden',
]

describe('stylesheet usage boundary', () => {
  test('every project class defined in the stylesheets is referenced', () => {
    const dead: string[] = []
    for (const sheet of filesUnder(join(root, 'packages/ui/src/styles'), /\.css$/)) {
      const css = readFileSync(sheet, 'utf8')
      const defined = new Set(
        [...css.matchAll(/\.([a-z][a-z0-9_-]*)/g)]
          .map(([, name]) => name)
          .filter((name) => projectPrefixes.some((prefix) => name.startsWith(prefix)))
      )
      for (const name of defined) {
        if (source.includes(name)) continue
        if (dynamicPrefixes.some((prefix) => name.startsWith(prefix))) continue
        dead.push(`${name} (${sheet.slice(root.length + 1)})`)
      }
    }
    expect(dead.sort()).toEqual([])
  })
})
