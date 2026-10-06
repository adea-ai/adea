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
  'packages/workspace-nav/src',
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

// Every project stylesheet root. Each is scanned recursively for `.css` files.
const stylesheetRoots = ['apps/web/src', 'packages/dev-view/src', 'packages/ui/src/styles']

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A class name counts as referenced only as a whole token, so
// `dev-browser-mini` is not kept alive by `dev-browser-mini__viewport`.
function referencesClass(text: string, name: string): boolean {
  return new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(name)}($|[^a-z0-9_-])`).test(text)
}

describe('stylesheet usage boundary', () => {
  test('scans every project stylesheet root', () => {
    const sheets = stylesheetRoots.flatMap((directory) =>
      filesUnder(join(root, directory), /\.css$/)
    )
    const relative = sheets.map((sheet) => sheet.slice(root.length + 1))
    expect(relative).toContain('apps/web/src/start/globals.css')
    expect(relative).toContain('packages/dev-view/src/browser/browser-pane.css')
    expect(relative).toContain('packages/ui/src/styles/conventional-workspace.css')
  })

  test('matches class names on token boundaries', () => {
    expect(referencesClass('class="dev-browser-mini__viewport"', 'dev-browser-mini')).toBe(false)
    expect(referencesClass("cn('workspace-scene-tabs')", 'workspace-scene-tab')).toBe(false)
    expect(referencesClass('class="a dev-browser-mini b"', 'dev-browser-mini')).toBe(true)
    expect(referencesClass("'workspace-scene-caption'", 'workspace-scene-caption')).toBe(true)
  })

  test('every project class defined in the stylesheets is referenced', () => {
    const dead: string[] = []
    const sheets = stylesheetRoots.flatMap((directory) =>
      filesUnder(join(root, directory), /\.css$/)
    )
    for (const sheet of sheets) {
      const css = readFileSync(sheet, 'utf8')
      const defined = new Set(
        [...css.matchAll(/\.([a-z][a-z0-9_-]*)/g)]
          .map(([, name]) => name)
          .filter((name) => projectPrefixes.some((prefix) => name.startsWith(prefix)))
      )
      for (const name of defined) {
        if (referencesClass(source, name)) continue
        if (dynamicPrefixes.some((prefix) => name.startsWith(prefix))) continue
        dead.push(`${name} (${sheet.slice(root.length + 1)})`)
      }
    }
    expect(dead.toSorted()).toEqual([])
  })
})
