import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

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

// The dev-only lucide-solid alias (apps/web/vite.config.ts) routes the bare
// specifier to start/lucide-solid-dev-shim.mjs in dev. The shim re-exports
// exactly the icons the client graph imports by name; a missed icon surfaces
// as "does not provide an export named" errors in dev.
// This boundary keeps the shim in lock-step with the sources and with the
// installed lucide-solid version. Every workspace package is scanned (not
// just the obvious UI ones) because any of them can enter the web client
// graph — e.g. packages/audio imports Music2.

const sourceRoots = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join('packages', entry.name, 'src'))
sourceRoots.push('apps/web/src')

const importedNames = new Set<string>(
  sourceRoots
    .flatMap((directory) => filesUnder(join(root, directory), /\.tsx?$/))
    .map((file) => readFileSync(file, 'utf8'))
    .flatMap((source) =>
      [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]lucide-solid['"]/g)]
        .flatMap(([, clause]) => clause.split(','))
        .map((name) =>
          name
            .replace(/^(type\s+)?/, '')
            .replace(/\s+as\s+[\w$]+\s*$/, '')
            .trim()
        )
        .filter(Boolean)
    )
)

const shimPath = join(root, 'apps/web/start/lucide-solid-dev-shim.jsx')
const shimSource = readFileSync(shimPath, 'utf8')
const shimExports = new Map<string, string>()
for (const [, name, file] of shimSource.matchAll(
  /export \{ default as ([\w$]+) \} from 'lucide-solid\/icons\/([\w-]+)'/g
)) {
  shimExports.set(name, file)
}

describe('lucide-solid dev shim', () => {
  test('covers every icon name imported from the barrel in the client graph', () => {
    const missing = [...importedNames].filter((name) => !shimExports.has(name)).toSorted()
    expect(
      missing.length > 0
        ? `start/lucide-solid-dev-shim.mjs is missing exports used in dev SSR: ${missing.join(', ')}. ` +
            `Add lines of the form "export { default as <Name> } from 'lucide-solid/icons/<kebab-file>'" ` +
            '(the kebab file for <Name> is the module the installed barrel re-exports it from).'
        : ''
    ).toBe('')
  })

  test('every shim icon module exists in the installed lucide-solid', () => {
    const require = createRequire(shimPath)
    const packageDir = resolve(dirname(require.resolve('lucide-solid')), '..', '..')
    const stale = [...shimExports].filter(
      ([, file]) => !existsSync(join(packageDir, 'dist/esm/icons', `${file}.mjs`))
    )
    expect(
      stale.length > 0
        ? `lucide-solid no longer ships icon module(s) referenced by start/lucide-solid-dev-shim.mjs: ${stale
            .map(([name, file]) => `${name} -> ${file}`)
            .join(', ')}. Regenerate the shim against the installed barrel.`
        : ''
    ).toBe('')
  })
})
