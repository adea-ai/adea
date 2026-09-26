import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

const localFiles = sourceRoots.flatMap((directory) =>
  filesUnder(join(root, directory), /\.tsx?$/)
)

const importedNames = new Set<string>(
  localFiles
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

function resolveSourceFile(base: string): string | undefined {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js'),
    join(base, 'index.jsx'),
  ]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

function publishedDependency(fromFile: string, specifier: string, publishedSourceRoot: string) {
  if (specifier.startsWith('#lib/')) {
    return resolveSourceFile(join(publishedSourceRoot, 'lib', specifier.slice('#lib/'.length)))
  }
  if (specifier.startsWith('#components/')) {
    return resolveSourceFile(
      join(publishedSourceRoot, 'components', specifier.slice('#components/'.length))
    )
  }
  if (specifier.startsWith('.')) {
    return resolveSourceFile(join(dirname(fromFile), specifier))
  }
  return undefined
}

// Published UI entries are source-resolved by Vite in dev. Follow only the
// entries imported by this checkout and their local #lib/#components closure;
// do not scan the published catalogue or every component in the package.
function nearestPackageManifest(file: string): string | undefined {
  let directory = dirname(file)
  while (directory.startsWith(root)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) return manifest
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

const publishedEntries = localFiles.flatMap((file) => {
  const matches = [
    ...readFileSync(file, 'utf8').matchAll(/from\s+['"](@adea-ai\/ui(?:\/[^'"]*)?)['"]/g),
  ]
  if (matches.length === 0) return []
  const manifest = nearestPackageManifest(file)
  if (!manifest) return []
  const publishedRequire = createRequire(manifest)
  const publishedSourceRoot = join(
    dirname(publishedRequire.resolve('@adea-ai/ui/package.json')),
    'src'
  )
  return matches.map(([, specifier]) => ({ specifier, publishedSourceRoot }))
})
const publishedSourceFiles = new Set<string>()
const publishedImportedNames = new Set<string>()
const resolvedPublishedEntries = publishedEntries.map(({ specifier, publishedSourceRoot }) => ({
  specifier,
  publishedSourceRoot,
  file: resolveSourceFile(
    specifier === '@adea-ai/ui'
      ? join(publishedSourceRoot, 'index')
      : join(publishedSourceRoot, specifier.slice('@adea-ai/ui/'.length))
  ),
}))
const unresolvedPublishedEntries = resolvedPublishedEntries.filter(
  (entry): entry is { specifier: string; publishedSourceRoot: string; file: undefined } =>
    !entry.file
)
const pendingPublishedFiles = resolvedPublishedEntries.filter(
  (entry): entry is { specifier: string; publishedSourceRoot: string; file: string } =>
    Boolean(entry.file)
)

while (pendingPublishedFiles.length > 0) {
  const entry = pendingPublishedFiles.pop()
  const file = entry?.file
  if (!file || publishedSourceFiles.has(file)) continue
  publishedSourceFiles.add(file)
  const source = readFileSync(file, 'utf8')
  for (const [, clause] of source.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]lucide-solid['"]/g
  )) {
    for (const part of clause.split(',')) {
      const name = part
        .replace(/^(type\s+)?/, '')
        .replace(/\s+as\s+[\w$]+\s*$/, '')
        .trim()
      if (name) publishedImportedNames.add(name)
    }
  }
  for (const [, specifier] of source.matchAll(
    /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g
  )) {
    const dependency = publishedDependency(file, specifier, entry.publishedSourceRoot)
    if (dependency) {
      pendingPublishedFiles.push({
        file: dependency,
        publishedSourceRoot: entry.publishedSourceRoot,
      })
    }
  }
}

const shimPath = join(root, 'apps/web/start/lucide-solid-dev-shim.jsx')
const shimSource = readFileSync(shimPath, 'utf8')
const shimExports = new Map<string, string>()
for (const [, name, file] of shimSource.matchAll(
  /export \{ default as ([\w$]+) \} from 'lucide-solid\/icons\/([\w-]+)'/g
)) {
  shimExports.set(name, file)
}

describe('lucide-solid dev shim', () => {
  test('resolves every imported published UI entry', () => {
    expect(
      unresolvedPublishedEntries.length > 0
        ? `Unable to resolve published UI source entries: ${unresolvedPublishedEntries
            .map(({ specifier }) => specifier)
            .toSorted()
            .join(', ')}. Check the installed @adea-ai/ui package entry or its public export.`
        : ''
    ).toBe('')
  })

  test('covers every icon name imported from local and published UI source closures', () => {
    const missing = [...new Set([...importedNames, ...publishedImportedNames])]
      .filter((name) => !shimExports.has(name))
      .toSorted()
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
