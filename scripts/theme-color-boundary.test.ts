import { describe, expect, test } from 'bun:test'

import { BASELINE, TOKEN_FILES, scanSource, scanThemeColors } from './check-theme-colors.mjs'

const root = new URL('..', import.meta.url).pathname

// CSS custom properties are the only legal color surface: a component that
// hardcodes a color cannot be rethemed, and the same color reappears with a
// slightly different value in the next component. The scanner is exercised below
// so the gate cannot pass by scanning nothing, and the baseline pins an exact
// count per file so it shrinks rather than grows.
describe('theme color contract', () => {
  test('keeps the component surface free of color literals', async () => {
    const { offBaseline, stale } = await scanThemeColors(root)

    expect(
      offBaseline.map(
        (entry) => `${entry.file}: ${entry.found} literals (baseline ${entry.allowed})`
      )
    ).toEqual([])
    // A baselined file that no longer has its literals must be removed from the
    // baseline, which is what makes the exception list burn down.
    expect(stale.map((entry) => `${entry.file}: ${entry.literals}`)).toEqual([])
  })

  test('flags a component literal but allows a token declaration', () => {
    expect(
      scanSource(`export const Badge = () => <span style={{ color: '#1a7f37' }} />`, 'x.tsx')
    ).toEqual([{ file: 'x.tsx', line: 1, literals: ['#1a7f37'] }])
    expect(scanSource(`.x { color: rgb(0 0 0 / 50%); }`, 'x.css')).toEqual([
      { file: 'x.css', line: 1, literals: ['rgb(0 0 0 / 50%)'] },
    ])
    // The declaration is where a literal becomes a token; its use is a token.
    expect(scanSource(`  --success: #1a7f37;`, 'x.css')).toEqual([])
    expect(scanSource(`  color: var(--success);`, 'x.css')).toEqual([])
    // Comments are documentation, not chrome.
    expect(scanSource(`/* was #1a7f37 */\n// see #123456`, 'x.tsx')).toEqual([])
  })

  test('every baseline entry states why and names a real file', async () => {
    expect(BASELINE.length).toBeGreaterThan(0)
    for (const entry of BASELINE) {
      expect(entry.literals).toBeGreaterThan(0)
      expect(entry.reason.length).toBeGreaterThan(20)
      const { violations } = await scanThemeColorsWithEntry(root, entry)
      expect(violations).toBe(entry.literals)
    }
  })

  test('the declared token layer is where literals are allowed to live', async () => {
    expect(TOKEN_FILES).toContain('packages/ui/src/styles/theme.css')
    for (const file of TOKEN_FILES) {
      const source = await Bun.file(`${root}${file}`).text()
      expect(source).toContain('--')
    }
  })
})

/** Re-scan with one baseline entry, to assert the file really carries that many. */
async function scanThemeColorsWithEntry(rootPath, entry) {
  const { offBaseline } = await scanThemeColors(rootPath)
  const found = offBaseline.find((candidate) => candidate.file === entry.file)
  if (found) return { violations: found.found }
  // Inside the baseline, the count is not reported; count it directly.
  const source = await Bun.file(`${rootPath}${entry.file}`).text()
  return {
    violations: scanSource(source, entry.file).reduce(
      (total, violation) => total + violation.literals.length,
      0
    ),
  }
}
