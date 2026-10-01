import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string) => readFileSync(join(import.meta.dir, '../src', path), 'utf8')

describe('private application UI boundary', () => {
  test('delegates mode selection and roving focus to the published controlled toggle', () => {
    const toggle = source('components/theme-toggle.tsx')
    expect(toggle).toContain("import { ThemeModeToggle } from '@adea-ai/ui/components/theme'")
    expect(toggle).toContain('mode={theme()}')
    expect(toggle).toContain('onModeChange={setTheme}')
    expect(toggle).not.toContain('role="radio"')
  })

  test('loads the shared layers before the private host layers', () => {
    const globals = source('styles/globals.css')
    const orderedImports = [
      "@import 'tailwindcss';",
      "@import '@adea-ai/ui/base.css';",
      "@import '@adea-ai/ui/theme.css';",
      "@import './base.css';",
      "@import './theme.css';",
    ].map((statement) => globals.indexOf(statement))

    expect(orderedImports.every((index) => index >= 0)).toBe(true)
    expect(orderedImports).toEqual(orderedImports.toSorted((left, right) => left - right))
  })

  test('leaves shared state, scrollbar, and animation styles to the published base layer', () => {
    const base = source('styles/base.css')
    expect(base).not.toContain('tw-animate-css')
    expect(base).not.toContain('@custom-variant data-open')
    expect(base).not.toContain('@utility no-scrollbar')
    expect(base).not.toContain('scroll-fade')
  })

  test('keeps host surface and gesture policy without copied shared resets', () => {
    const theme = source('styles/theme.css')
    expect(theme).toContain('.workspace-on-screen-controls')
    expect(theme).toContain("[data-surface='frosted'] .conventional-dialog")
    expect(theme).not.toContain('button:not(:disabled)')
    expect(theme).not.toContain('border-color: var(--border)')
    expect(theme).not.toContain('background: var(--background)')
  })
})
