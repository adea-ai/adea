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

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.css']
// Discover common stylesheet variants too; until scanSource has a parser for
// them, they must fail closed rather than silently bypass the CSS contract.
const SOURCE_STYLESHEET_EXTENSIONS = [
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.pcss',
  '.postcss',
]
/** Source surfaces to scan. */
export const SCAN_ROOTS = [
  { directory: 'packages/ui/src', extensions: SCAN_EXTENSIONS },
  { directory: 'packages/workspace-ui/src', extensions: SCAN_EXTENSIONS },
  { directory: 'packages/dev-view/src', extensions: SCAN_EXTENSIONS },
  { directory: 'apps/web/src', extensions: SCAN_EXTENSIONS },
]
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'target', '.turbo'])

/**
 * Non-keyword color literal shapes. CSS named colors are scanned separately
 * in declaration values; TS/TSX class names and strings stay out of that scan.
 * CSS custom properties are not an exemption: values must come from the
 * published theme package or an exact finite baseline below.
 */
const COLOR_LITERALS = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\([^)]*\)/g

/** CSS Color 4 named color keywords. CSS-wide and semantic keywords are absent. */
const CSS_NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(
    ' '
  )
)

/** Properties whose grammar accepts color values, plus every custom property. */
const COLOR_PROPERTIES = new Set(
  `accent-color background background-color background-image border border-bottom border-bottom-color border-color border-left border-left-color border-right border-right-color border-top border-top-color box-shadow caret-color color column-rule column-rule-color fill filter flood-color font lighting-color outline outline-color scrollbar-color stop-color stroke tap-highlight-color text-decoration text-decoration-color text-emphasis text-emphasis-color text-fill-color text-shadow text-stroke text-stroke-color`.split(
    ' '
  )
)

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

  source = file.endsWith('.css')
    ? stripBlockComments(source)
    : stripBlockComments(stripLineComments(source))
  if (file.endsWith('.css')) return scanCssSource(source, file)

  const violations = []
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

    const literals = [...line.matchAll(COLOR_LITERALS)].map(([literal]) => literal)
    if (literals.length > 0)
      violations.push({ file, line: index + 1, literals, overriddenTokens: [] })
  }
  return violations
}

function scanCssSource(source, file) {
  const byLine = new Map()
  const add = (offset, literal, token) => {
    const line = source.slice(0, offset).split('\n').length
    const violation = byLine.get(line) ?? { file, line, literals: [], overriddenTokens: [] }
    if (literal) violation.literals.push(literal)
    if (token) violation.overriddenTokens.push(token)
    byLine.set(line, violation)
  }

  for (const declaration of cssDeclarations(source)) {
    const property = declaration.property.toLowerCase()
    if (SHARED_PALETTE_TOKENS.has(property)) add(declaration.start, null, property)
    const value = maskCssStringsAndUrls(declaration.value)
    for (const match of value.matchAll(COLOR_LITERALS)) {
      add(declaration.valueStart + match.index, match[0], null)
    }
    if (!property.startsWith('--') && !isColorProperty(property)) continue
    for (const match of value.matchAll(/[-_a-zA-Z][-_a-zA-Z0-9]*/g)) {
      // Match whole CSS identifiers so names such as --shade_red and
      // --shade2red are not mistaken for the color keyword `red`.
      if (CSS_NAMED_COLORS.has(match[0].toLowerCase())) {
        add(declaration.valueStart + match.index, match[0], null)
      }
    }
  }
  return [...byLine.values()].toSorted((left, right) => left.line - right.line)
}

function isColorProperty(property) {
  const unprefixed = property.replace(/^-(?:webkit|moz|ms|o)-/, '')
  return (
    COLOR_PROPERTIES.has(unprefixed) ||
    /^border-(?:block|inline)(?:-(?:start|end))?(?:-color)?$/.test(unprefixed)
  )
}

/** Extract declarations while honoring strings, comments, and function syntax. */
function cssDeclarations(source) {
  const declarations = []
  let segmentStart = 0
  let quote = ''
  let escaped = false
  let parentheses = 0
  let brackets = 0

  const finish = (end) => {
    const segment = source.slice(segmentStart, end)
    const colon = findCssColon(segment)
    if (colon < 0) return
    const property = segment.slice(0, colon).trim()
    if (!/^--[\w-]+$|^-?[a-z][\w-]*$/i.test(property)) return
    const valueStart = segmentStart + colon + 1
    declarations.push({
      property,
      start: segmentStart + segment.indexOf(property),
      value: source.slice(valueStart, end),
      valueStart,
    })
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    else if (parentheses === 0 && brackets === 0 && character === '{') {
      segmentStart = index + 1
    } else if (parentheses === 0 && brackets === 0 && character === ';') {
      finish(index)
      segmentStart = index + 1
    } else if (parentheses === 0 && brackets === 0 && character === '}') {
      finish(index)
      segmentStart = index + 1
    }
  }
  finish(source.length)
  return declarations
}

function findCssColon(segment) {
  let quote = ''
  let escaped = false
  let parentheses = 0
  let brackets = 0
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    else if (character === ':' && parentheses === 0 && brackets === 0) return index
  }
  return -1
}

/** Mask strings and url() payloads while preserving offsets for diagnostics. */
function maskCssStringsAndUrls(value) {
  const output = value.split('')
  let quote = ''
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    if (quote) {
      output[index] = ' '
      if (escaped) escaped = false
      else if (value[index] === '\\') escaped = true
      else if (value[index] === quote) quote = ''
      continue
    }
    if (value[index] === '"' || value[index] === "'") {
      quote = value[index]
      output[index] = ' '
      continue
    }
    const url = value.slice(index).match(/^url\s*\(/i)
    if (url) {
      let depth = 0
      let urlQuote = ''
      let urlEscaped = false
      for (let cursor = index; cursor < value.length; cursor += 1) {
        const character = value[cursor]
        output[cursor] = ' '
        if (urlQuote) {
          if (urlEscaped) urlEscaped = false
          else if (character === '\\') urlEscaped = true
          else if (character === urlQuote) urlQuote = ''
        } else if (character === '"' || character === "'") urlQuote = character
        else if (character === '(') depth += 1
        else if (character === ')' && --depth === 0) {
          index = cursor
          break
        }
      }
    }
  }
  return output.join('')
}

/** Replace block-comment characters but retain line breaks for stable locations. */
function stripBlockComments(source) {
  let result = ''
  let inComment = false
  let quote = ''
  let escaped = false
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
    if (quote) {
      result += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = ''
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      result += current
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

/** Strip JavaScript line comments without treating quotes as comment starts. */
function stripLineComments(source) {
  let result = ''
  let inComment = false
  let inBlockComment = false
  let quote = ''
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (inComment) {
      if (current === '\n') {
        result += '\n'
        inComment = false
      } else {
        result += ' '
      }
      continue
    }
    if (inBlockComment) {
      result += current
      if (current === '*' && next === '/') {
        result += next
        index += 1
        inBlockComment = false
      }
      continue
    }
    if (quote) {
      result += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === quote) quote = ''
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      result += current
      continue
    }
    if (current === '/' && next === '*') {
      result += '/*'
      index += 1
      inBlockComment = true
      continue
    }
    if (current === '/' && next === '/') {
      result += '  '
      index += 1
      inComment = true
      continue
    }
    result += current
  }
  return result
}

async function* sourceFiles(directory, extensions) {
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
      yield* sourceFiles(path, extensions)
      continue
    }
    if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      yield path
    }
  }
}

/**
 * Report stylesheet sources outside the configured scan roots and roots that
 * stopped resolving or no longer contain any files with their configured
 * extensions. This inventory is intentionally based on the working tree, so a
 * newly added local source stylesheet cannot evade the gate before it is added
 * to Git.
 */
export async function findScanInventoryGaps(root, scanRoots = SCAN_ROOTS) {
  const missingRoots = []
  const emptyRoots = []

  for (const scanRoot of scanRoots) {
    const directory = join(root, scanRoot.directory)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      missingRoots.push(scanRoot.directory)
      continue
    }

    if (entries.length === 0) {
      emptyRoots.push(scanRoot.directory)
      continue
    }

    const eligibleFiles = sourceFiles(directory, scanRoot.extensions)
    if ((await eligibleFiles.next()).done) emptyRoots.push(scanRoot.directory)
  }

  const uncoveredStyles = []
  for (const collection of ['packages', 'apps']) {
    // Desktop hosts can nest their sources (apps/desktop/shell/src). Searching
    // only apps/*/src would silently miss a new stylesheet in those hosts.
    for await (const path of sourceFiles(join(root, collection), SOURCE_STYLESHEET_EXTENSIONS)) {
      const file = relative(root, path).split(sep).join('/')
      if (!file.split('/').slice(0, -1).includes('src')) continue
      const extension = SOURCE_STYLESHEET_EXTENSIONS.find((suffix) => file.endsWith(suffix))
      if (extension !== '.css' || !isCoveredSource(file, extension, scanRoots)) {
        uncoveredStyles.push(file)
      }
    }
  }

  return {
    uncoveredStyles: uncoveredStyles.toSorted(),
    missingRoots: missingRoots.toSorted(),
    emptyRoots: emptyRoots.toSorted(),
  }
}

function isCoveredSource(file, extension, scanRoots) {
  return scanRoots.some((scanRoot) => {
    const directory = scanRoot.directory.replace(/\/$/, '')
    return (
      (file === directory || file.startsWith(`${directory}/`)) &&
      scanRoot.extensions.includes(extension)
    )
  })
}

/**
 * Every color literal in the component surface, grouped by file, with the
 * baseline applied. Returns both the offenders and the baseline entries that no
 * longer match their count.
 */
export async function scanThemeColors(root) {
  const inventory = await findScanInventoryGaps(root)
  if (
    inventory.uncoveredStyles.length > 0 ||
    inventory.missingRoots.length > 0 ||
    inventory.emptyRoots.length > 0
  ) {
    const details = [
      inventory.uncoveredStyles.length > 0
        ? `uncovered product stylesheets: ${inventory.uncoveredStyles.join(', ')}`
        : null,
      inventory.missingRoots.length > 0
        ? `missing configured scan roots: ${inventory.missingRoots.join(', ')}`
        : null,
      inventory.emptyRoots.length > 0
        ? `configured scan roots with no eligible sources: ${inventory.emptyRoots.join(', ')}`
        : null,
    ].filter(Boolean)
    throw new Error(`Theme color scan inventory is incomplete: ${details.join('; ')}`)
  }

  const counts = new Map()
  for (const scanRoot of SCAN_ROOTS) {
    for await (const path of sourceFiles(join(root, scanRoot.directory), scanRoot.extensions)) {
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
