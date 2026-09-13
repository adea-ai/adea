// Theme color contract: CSS custom properties are the only legal color surface.
//
// A component that hardcodes `#1a7f37` cannot be rethemed, and the same green
// reappears in the next component with a slightly different value. The rule this
// scanner enforces is narrow enough to be actionable: color literals may appear
// only where a custom property is *declared* (`--token: #value;`), never where a
// property is *used*. Everything else is either a violation or an entry in the
// baseline below, which is expected to shrink.
//
// `scripts/theme-color-boundary.test.ts` runs it in the validation lane and
// exercises the scanner itself, so the gate cannot pass by scanning nothing.

import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Where components and app styles live. */
const SCAN_ROOTS = ['packages/ui/src', 'packages/workspace-ui/src', 'apps/web/src']
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.css']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'target', '.turbo'])

/**
 * Color literal shapes. Named colors are out of scope (`white`/`transparent`
 * are too ambiguous in class strings to be worth the false positives), and
 * CSS custom properties are the sanctioned surface.
 */
const COLOR_LITERALS = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^)]*\)/g

/**
 * Files whose color literals are the theme itself. A token declaration is the
 * one place a literal belongs, so declared token layers are exempt by file.
 * Keep this list to the token layer only — everything else burns down.
 */
export const TOKEN_FILES = [
  'packages/ui/src/styles/theme.css',
  'packages/ui/src/styles/workspace-shell.css',
]

/**
 * Literals that cannot move behind a custom property. Each entry pins an exact
 * count: adding a literal fails, and so does fixing one without updating the
 * baseline, which is what keeps the list shrinking.
 */
export const BASELINE = [
  {
    file: 'apps/web/src/start/routes/__root.tsx',
    literals: 2,
    reason:
      'browser theme-color meta tags take a color value rather than a custom property, so the light and dark page background have to be written out',
  },
]

/** A color literal outside the token layer. Exported so the gate's own
 * behaviour is testable. */
export function scanSource(source, file) {
  const violations = []
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

    const literals = line.match(COLOR_LITERALS)
    if (!literals || literals.length === 0) continue

    // A custom property declaration is the token layer, wherever it sits: a
    // `--name: <color>` right-hand side is how a literal becomes a token.
    if (file.endsWith('.css')) {
      const declaration = /^\s*--[a-zA-Z0-9-]+\s*:/.test(line)
      if (declaration) continue
    }
    violations.push({ file, line: index + 1, literals })
  }
  return violations
}

async function* sourceFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      yield* sourceFiles(path)
      continue
    }
    if (entry.isFile() && SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      yield path
    }
  }
}

/**
 * Every color literal in the component surface, grouped by file, with the
 * baseline applied. Returns both the offenders and the baseline entries that no
 * longer match their count.
 */
export async function scanThemeColors(root) {
  const counts = new Map()
  for (const scanRoot of SCAN_ROOTS) {
    for await (const path of sourceFiles(join(root, scanRoot))) {
      const file = relative(root, path).split(sep).join('/')
      const source = await readFile(path, 'utf8')
      const violations = scanSource(source, file)
      if (violations.length > 0) counts.set(file, violations)
    }
  }
  for (const file of TOKEN_FILES) counts.delete(file)

  const baseline = new Map(BASELINE.map((entry) => [entry.file, entry.literals]))
  const offBaseline = []
  const stale = []

  for (const [file, violations] of counts) {
    const allowed = baseline.get(file) ?? 0
    const found = violations.reduce((total, violation) => total + violation.literals.length, 0)
    if (found > allowed) {
      offBaseline.push({ file, allowed, found, violations })
    }
    if (found === allowed) baseline.delete(file)
  }
  for (const [file, literals] of baseline) {
    stale.push({ file, literals })
  }

  return { offBaseline, stale }
}
