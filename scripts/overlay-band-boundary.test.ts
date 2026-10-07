import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

const themeCssPath = resolve(root, 'packages/ui/src/styles/theme.css')
const themeCss = readFileSync(themeCssPath, 'utf8')
const workspaceCssPath = resolve(root, 'packages/ui/src/styles/conventional-workspace.css')
const workspaceCss = readFileSync(workspaceCssPath, 'utf8')

const bandSelectors = [
  "[role='dialog'][data-variant] [data-slot='sheet-header']",
  "[role='dialog'][data-variant] [data-slot='sheet-footer']",
]

/** Removes comment blocks so brace scanning sees only real CSS. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/\S/g, ' '))
}

/**
 * Offset of a selector at top level, or -1 when it does not appear at all.
 * Walks the stylesheet tracking the block stack: every opening brace pushes
 * the kind of block that opened before it (an at-rule such as `@layer` or
 * `@media`, or a plain rule), so the caller can tell a top-level rule from one
 * filed into a layer or media branch.
 */
function topLevelOffset(source: string, needle: string): number {
  const stack: string[] = []
  let pendingAtRule: string | null = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '@') {
      const match = /^@([a-z-]+)/.exec(source.slice(index))
      if (match) pendingAtRule = match[1]
    }
    if (char === '{') {
      stack.push(pendingAtRule ?? 'rule')
      pendingAtRule = null
      continue
    }
    if (char === '}') {
      stack.pop()
      continue
    }
    if (stack.length === 0 && source.startsWith(needle, index)) {
      return index
    }
  }
  return -1
}

// The two-toned overlay bands are host surface policy over the published
// overlay parts, and their top-level (unlayered) placement is load-bearing:
// the published SheetFooter paints its own `bg-background` utility on the same
// element, and only unlayered author CSS outranks a layered declaration in the
// cascade. Filing these rules into any layer would let that utility win and
// silently flatten the band — below the perceptual threshold the visual lanes
// compare with, so nothing else would fail.
describe('overlay band contract', () => {
  test('keeps every band selector in the host theme stylesheet', () => {
    const source = withoutComments(themeCss)
    for (const selector of bandSelectors) {
      expect(source).toContain(selector)
    }
  })

  test('keeps the band rules top-level so they outrank the published utilities', () => {
    const source = withoutComments(themeCss)
    for (const selector of bandSelectors) {
      expect(topLevelOffset(source, selector)).toBeGreaterThanOrEqual(0)
    }
  })

  test('paints the bands with the muted rung token, not a literal', () => {
    const source = withoutComments(themeCss)
    const ruleStart = topLevelOffset(source, bandSelectors[0])
    expect(ruleStart).toBeGreaterThanOrEqual(0)
    const ruleEnd = source.indexOf('}', ruleStart)
    const rule = source.slice(ruleStart, ruleEnd + 1)
    expect(rule).toContain(bandSelectors[1])
    expect(rule).toContain('background-color: var(--muted)')
  })

  test('documents why the placement is load-bearing', () => {
    expect(themeCss).toContain('MUST stay top-level')
    expect(themeCss).toContain('bg-background')
  })
})

// The modal surface is painted by the published library: DialogContent composes
// `dialogSurface`, whose `bg-background` utility lives in Tailwind's utilities
// layer. An unlayered author rule painting `.conventional-dialog`'s own
// background would beat that utility in the cascade and leave only the scrim
// behind the panel — the exact defect the owner audit's tkvr-2 item describes,
// whose cited `background: transparent` rule does not exist in the tree (the
// cited line range is the palette token block). This contract keeps it that
// way: the workspace stylesheet never paints a conventional dialog's own
// background, and translucent-dialog intent stays in theme.css, where the
// frosted surface policy already owns it as host surface policy.
describe('conventional dialog surface contract', () => {
  const surfaceSelectors = ['.conventional-dialog {', '.conventional-settings-dialog {']

  test('never paints the dialog surface in the workspace stylesheet', () => {
    const source = withoutComments(workspaceCss)
    for (const selector of surfaceSelectors) {
      let searchFrom = 0
      for (;;) {
        const ruleStart = topLevelOffset(source.slice(searchFrom), selector)
        if (ruleStart < 0) break
        const absoluteStart = searchFrom + ruleStart
        const ruleEnd = source.indexOf('}', absoluteStart)
        const rule = source.slice(absoluteStart, ruleEnd + 1)
        expect(rule).not.toMatch(/^\s*(background|background-color)\s*:/m)
        searchFrom = absoluteStart + selector.length
      }
    }
  })

  test('keeps translucent-dialog intent in the host theme policy', () => {
    const source = withoutComments(themeCss)
    // The frosted policy is the sanctioned background painter: it resolves the
    // user's chosen surface, and both reduced-transparency paths clamp it back
    // to opaque. (#1115 re-keyed the policy from the retiring
    // .conventional-dialog class onto the role hook.)
    expect(source).toContain("[data-surface='frosted'] [role='dialog']:not([data-variant])")
    expect(source).toContain('backdrop-filter')
  })
})
