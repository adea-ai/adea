import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import {
  BASELINE,
  GENERATED_THEME_FILES,
  SCAN_ROOTS,
  scanSource,
  scanThemeColors,
} from './check-theme-colors.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

// Palette literals belong to the generator-checked published theme projections,
// not consumer custom properties. The scanner is exercised below so the gate
// cannot pass by scanning nothing, and its finite baseline can only shrink.
describe('theme color contract', () => {
  test('keeps the component surface free of color literals', async () => {
    const { offBaseline, stale } = await scanThemeColors(root)

    expect(
      offBaseline.map(
        (entry) =>
          `${entry.file}: ${entry.found} literals (baseline ${entry.allowed})${
            entry.overriddenTokens.length > 0
              ? `; shared role overrides: ${entry.overriddenTokens.join(', ')}`
              : ''
          }`
      )
    ).toEqual([])
    // A baselined file that no longer has its literals must be removed from the
    // baseline, which is what makes the exception list burn down.
    expect(stale.map((entry) => `${entry.file}: ${entry.literals}`)).toEqual([])
  })

  test('flags literals and rejects consumer-authored token values', () => {
    expect(
      scanSource(`export const Badge = () => <span style={{ color: '#1a7f37' }} />`, 'x.tsx')
    ).toEqual([{ file: 'x.tsx', line: 1, literals: ['#1a7f37'], overriddenTokens: [] }])
    expect(scanSource(`.x { color: rgb(0 0 0 / 50%); }`, 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: ['rgb(0 0 0 / 50%)'], overriddenTokens: [] },
    ])
    // Consumer aliases may refer to shared semantic tokens, but may not author
    // another palette value under an arbitrary custom property.
    expect(scanSource(`  --success: #1a7f37;`, 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: ['#1a7f37'], overriddenTokens: ['--success'] },
    ])
    expect(scanSource(`  color: var(--success);`, 'x.css')).toEqual([])
    expect(scanSource(`  --private-brand: #1a7f37;`, 'x.css')[0]?.literals).toEqual(['#1a7f37'])
  })

  test('rejects canonical role overrides even when they only alias a value', () => {
    expect(scanSource(`.workspace-shell { --background: var(--private-brand); }`, 'x.css')).toEqual(
      [{ file: 'x.css', line: 1, literals: [], overriddenTokens: ['--background'] }]
    )
  })

  test('flags CSS named colors in declarations and var fallbacks', () => {
    expect(scanSource('.x { color: red; --private: white; }', 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: ['red', 'white'], overriddenTokens: [] },
    ])
    expect(scanSource('.x { color: var(--semantic, rebeccapurple); }', 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: ['rebeccapurple'], overriddenTokens: [] },
    ])
    expect(
      scanSource('.x { background-image: linear-gradient(red, transparent); }', 'x.css')
    ).toEqual([{ file: 'x.css', line: 1, literals: ['red'], overriddenTokens: [] }])
    expect(scanSource('.x { --private: var(--semantic, white); }', 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: ['white'], overriddenTokens: [] },
    ])
  })

  test('scans named colors in logical, scrollbar, and vendor paint properties', () => {
    expect(
      scanSource(
        '.x { border-inline-color: red; border-inline-start: 1px solid cyan; border-block-end-color: RebeccaPurple; scrollbar-color: silver gray; stop-color: purple; -webkit-text-fill-color: blue; -webkit-text-stroke: white 1px; -webkit-text-stroke-color: orange; -webkit-tap-highlight-color: green; }',
        'x.css'
      )
    ).toEqual([
      {
        file: 'x.css',
        line: 1,
        literals: [
          'red',
          'cyan',
          'RebeccaPurple',
          'silver',
          'gray',
          'purple',
          'blue',
          'white',
          'orange',
          'green',
        ],
        overriddenTokens: [],
      },
    ])
    expect(
      scanSource(
        '.x { border-inline-color: var(--border); scrollbar-color: var(--muted) var(--background); -webkit-text-fill-color: var(--foreground); }',
        'x.css'
      )
    ).toEqual([])
  })

  test('does not mistake color words inside custom-property identifiers for values', () => {
    expect(
      scanSource(
        '.x { color: var(--shade_red); background: var(--shade2red); --private: var(--my_red_token); }',
        'x.css'
      )
    ).toEqual([])
  })

  test('scans all Dev View UI source with the shared color boundary', () => {
    expect(SCAN_ROOTS).toContainEqual({
      directory: 'packages/dev-view/src',
      extensions: ['.ts', '.tsx', '.css'],
    })
  })

  test('ignores CSS strings, URLs, comments, and semantic token aliases', () => {
    expect(
      scanSource(
        '.x { content: "red --background: blue"; background-image: url(red.png); color: var(--semantic, transparent); border-color: currentColor; outline-color: inherit; font-family: red; /* white */ }',
        'x.css'
      )
    ).toEqual([])
    expect(scanSource('.x { color: var(--semantic); }', 'x.css')).toEqual([])
    expect(scanSource('.x { content: "/* red */"; color: blue; }', 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: ['blue'], overriddenTokens: [] },
    ])
    expect(scanSource('const className = "text-red-500"', 'x.tsx')).toEqual([])
  })

  test('scans declarations independently when several share one line', () => {
    expect(scanSource(`--private: #123456; color: #abcdef;`, 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: ['#123456', '#abcdef'], overriddenTokens: [] },
    ])
    expect(scanSource(`/* note #599 */ --background: var(--private);`, 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: [], overriddenTokens: ['--background'] },
    ])
  })

  test('limits generated palette allowance to generator-validated outputs', () => {
    expect(GENERATED_THEME_FILES).toEqual([
      'packages/ui/src/styles/canonical-themes.css',
      'packages/ui/src/components/canonical-theme-data.ts',
      'packages/ui/src/components/canonical-theme-css-data.ts',
      'packages/ui/src/components/canonical-theme-meta.ts',
    ])
    expect(GENERATED_THEME_FILES).not.toContain('packages/ui/src/styles/theme.css')
    expect(GENERATED_THEME_FILES).not.toContain('packages/ui/src/styles/workspace-shell.css')
    expect(scanSource('--background: #123456; color: #abcdef;', GENERATED_THEME_FILES[0])).toEqual(
      []
    )
  })

  test('comments remain documentation and scanning resumes after them', () => {
    // Comments are documentation, not chrome.
    expect(scanSource(`/* was #1a7f37 */\n// see #123456`, 'x.tsx')).toEqual([])
    // A block comment's body is documentation on every line it spans, so an
    // issue number inside it is not a color literal (the #599 false positive).
    expect(
      scanSource(
        `/* muted text darkened\n   for WCAG 1.4.3 (#599)\n*/\n.x { color: var(--muted-foreground); }`,
        'x.css'
      )
    ).toEqual([])
    expect(scanSource(`/* a\n b */\n.x { color: #123456; }`, 'x.css')).toEqual([
      { file: 'x.css', line: 3, literals: ['#123456'], overriddenTokens: [] },
    ])
    expect(scanSource(`// don't parse the following block comment\n/** #399 */\n`, 'x.ts')).toEqual(
      []
    )
    expect(
      scanSource(
        `const url = "https://example.test/#123456"\nconst template = \`// #abcdef\``,
        'x.ts'
      )
    ).toEqual([
      { file: 'x.ts', line: 1, literals: ['#123456'], overriddenTokens: [] },
      { file: 'x.ts', line: 2, literals: ['#abcdef'], overriddenTokens: [] },
    ])
  })

  test('every baseline entry states why and names a real file', async () => {
    expect(BASELINE.map(({ file, literals }) => [file, literals])).toEqual([
      ['apps/web/src/start/routes/__root.tsx', 2],
      ['packages/ui/src/styles/base.css', 26],
    ])
    for (const entry of BASELINE) {
      expect(entry.literals).toBeGreaterThan(0)
      expect(entry.reason.length).toBeGreaterThan(20)
      const { violations } = await scanThemeColorsWithEntry(root, entry)
      expect(violations).toBe(entry.literals)
    }
  })

  test('only generated palette projections are exempt from literal scanning', async () => {
    expect(GENERATED_THEME_FILES).not.toContain('packages/ui/src/styles/theme.css')
    expect(GENERATED_THEME_FILES).toContain('packages/ui/src/components/canonical-theme-data.ts')
    expect(GENERATED_THEME_FILES).not.toContain('packages/ui/src/components/appearance.ts')
    for (const file of GENERATED_THEME_FILES) {
      const source = await Bun.file(`${root}${file}`).text()
      expect(source).toContain('Generated from the isolated @adea-ai/themes')
    }
  })
})

/** The full-tree test checks scope; count each baseline file directly here. */
async function scanThemeColorsWithEntry(rootPath, entry) {
  const source = await Bun.file(`${rootPath}${entry.file}`).text()
  return {
    violations: scanSource(source, entry.file).reduce(
      (total, violation) => total + violation.literals.length,
      0
    ),
  }
}
