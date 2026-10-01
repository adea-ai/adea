// Theme color contract: literal palettes belong to the generated catalogue.
//
// A component that hardcodes `#1a7f37` cannot be rethemed, and the same green
// reappears in the next component with a slightly different value. The rule this
// scanner enforces is narrow enough to be actionable: only exact outputs of the
// published-theme generator may contain palette literals. Consumers may alias
// semantic tokens, but may not define palette values or override shared roles.
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
 * CSS custom properties are not an exemption: values must come from the
 * published theme package or an exact finite baseline below.
 */
const COLOR_LITERALS = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^)]*\)/g

/**
 * Exact outputs written and verified by packages/ui/scripts/generate-canonical-theme-data.ts.
 * packages/ui's themes:check runs that generator with --check in its test lane.
 * Do not add app-authored sheets or token aliases here.
 */
export const GENERATED_THEME_FILES = [
  'packages/ui/src/styles/canonical-themes.css',
  'packages/ui/src/components/canonical-theme-data.ts',
  'packages/ui/src/components/canonical-theme-css-data.ts',
  'packages/ui/src/components/canonical-theme-meta.ts',
]

/** Canonical palette roles may only be written by the generated projection. */
const SHARED_PALETTE_TOKENS = new Set([
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--primary-hover',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--destructive-action',
  '--destructive-action-foreground',
  '--destructive-subtle',
  '--success',
  '--success-foreground',
  '--success-subtle',
  '--warning',
  '--warning-foreground',
  '--warning-subtle',
  '--info',
  '--info-foreground',
  '--info-subtle',
  '--border',
  '--input',
  '--ring',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-accent',
  '--sidebar-border',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-ring',
  '--sidebar-muted-foreground',
  '--surface-sunken',
  '--surface-hover',
  '--surface-active',
  '--chrome',
  '--terminal-background',
  '--terminal-foreground',
  '--terminal-cursor',
  '--terminal-selection',
  ...[
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'bright-black',
    'bright-red',
    'bright-green',
    'bright-yellow',
    'bright-blue',
    'bright-magenta',
    'bright-cyan',
    'bright-white',
  ].map((name) => `--terminal-ansi-${name}`),
  ...[
    'keyword',
    'string',
    'number',
    'comment',
    'function',
    'variable',
    'type',
    'tag',
    'attribute',
    'operator',
    'heading',
    'link',
    'diff-add',
    'diff-delete',
    'diff-hunk',
    'search-match',
  ].map((name) => `--editor-${name}`),
  ...[1, 2, 3, 4, 5, 6].map((index) => `--chart-${index}`),
  '--diff-add',
  '--diff-add-foreground',
  '--diff-delete',
  '--diff-delete-foreground',
  '--diff-hunk',
  '--diff-hunk-foreground',
  '--scrim',
  '--scrim-foreground',
  '--scrim-edge',
])

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
  {
    file: 'packages/ui/src/styles/base.css',
    literals: 26,
    reason:
      'scroll-fade masks use #000 as an opaque alpha stop in a mask-image gradient, which composites alpha rather than painting a color',
  },
]

/** A consumer color literal or canonical role override. */
export function scanSource(source, file) {
  if (GENERATED_THEME_FILES.includes(file)) return []

  source = stripBlockComments(source)
  const violations = []
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

    const literals = [...line.matchAll(COLOR_LITERALS)].map(([literal]) => literal)
    const overriddenTokens = []
    if (file.endsWith('.css')) {
      for (const [, token] of line.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*[^;{}]*/g)) {
        if (SHARED_PALETTE_TOKENS.has(token)) overriddenTokens.push(token)
      }
    }
    if (literals.length > 0 || overriddenTokens.length > 0) {
      violations.push({ file, line: index + 1, literals, overriddenTokens })
    }
  }
  return violations
}

/** Replace block-comment characters but retain line breaks for stable locations. */
function stripBlockComments(source) {
  let result = ''
  let inComment = false
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (inComment) {
      if (current === '*' && next === '/') {
        result += '  '
        index += 1
        inComment = false
      } else {
        result += current === '\n' ? '\n' : ' '
      }
      continue
    }
    if (current === '/' && next === '*') {
      result += '  '
      index += 1
      inComment = true
      continue
    }
    result += current
  }
  return result
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
  const baseline = new Map(BASELINE.map((entry) => [entry.file, entry.literals]))
  const offBaseline = []
  const stale = []

  for (const [file, violations] of counts) {
    const allowed = baseline.get(file) ?? 0
    const found = violations.reduce((total, violation) => total + violation.literals.length, 0)
    const overriddenTokens = violations.flatMap((violation) => violation.overriddenTokens)
    if (found > allowed || overriddenTokens.length > 0) {
      offBaseline.push({ file, allowed, found, overriddenTokens, violations })
    }
    if (found === allowed && overriddenTokens.length === 0) baseline.delete(file)
  }
  for (const [file, literals] of baseline) {
    stale.push({ file, literals })
  }

  return { offBaseline, stale }
}
