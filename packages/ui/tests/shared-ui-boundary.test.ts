import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string) => readFileSync(join(import.meta.dir, '../src', path), 'utf8')
const repositoryFile = (path: string) =>
  readFileSync(join(import.meta.dir, '../../..', path), 'utf8')

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
      "@import '@adea-ai/ui/appearance-font-settings.css';",
      "@import '@adea-ai/ui/fonts.css';",
      "@import './base.css';",
      "@import './theme.css';",
    ].map((statement) => globals.indexOf(statement))

    expect(orderedImports.every((index) => index >= 0)).toBe(true)
    expect(orderedImports).toEqual(orderedImports.toSorted((left, right) => left - right))
    const webGlobals = repositoryFile('apps/web/src/start/globals.css')
    expect(webGlobals).toContain("@import '@adea-ai/ui/appearance-font-settings.css';")
    expect(
      webGlobals.indexOf("@import '@adea-ai/ui/appearance-font-settings.css';")
    ).toBeGreaterThan(webGlobals.indexOf("@import '@adea-ai/ui/theme.css';"))
    expect(webGlobals).toContain("@import '@adea-ai/ui/fonts.css';")
    expect(webGlobals.indexOf("@import '@adea-ai/ui/fonts.css';")).toBeGreaterThan(
      webGlobals.indexOf("@import '@adea-ai/ui/theme.css';")
    )
  })

  test('leaves shared state, scrollbar, and animation styles to the published base layer', () => {
    const base = source('styles/base.css')
    expect(base).not.toContain('tw-animate-css')
    expect(base).not.toContain('@custom-variant data-open')
    expect(base).not.toContain('@utility no-scrollbar')
    expect(base).not.toContain('scroll-fade')
  })

  test('keeps host surface policy without copied shared resets', () => {
    const theme = source('styles/theme.css')
    expect(theme).toContain("[data-surface='frosted'] .conventional-dialog")
    expect(theme).not.toContain('button:not(:disabled)')
    expect(theme).not.toContain('border-color: var(--border)')
    expect(theme).not.toContain('background: var(--background)')
  })

  test('keeps raw and wrapper exemptions at the main-branch ratchet baseline', () => {
    type Override = { files: string[]; rules: Record<string, string> }
    const config = JSON.parse(repositoryFile('.oxlintrc.json')) as { overrides: Override[] }
    const rawInteractiveExemptions = config.overrides.flatMap(({ files, rules }) =>
      rules['adea/no-raw-interactive-elements'] === 'off' ? files : []
    )
    const wrapperExemptions = config.overrides.flatMap(({ files, rules }) =>
      rules['adea/no-interactive-wrappers'] === 'off' ? files : []
    )
    const appearanceRules = [
      'shadcn/no-restyle',
      'shadcn/no-arbitrary-values',
      'shadcn/no-inline-styles',
      'shadcn/require-static-classes',
    ]
    const appearanceExemptions = config.overrides.flatMap(({ files, rules }) =>
      appearanceRules.some((rule) => rules[rule] === 'off') ? files : []
    )

    expect(rawInteractiveExemptions).toEqual([])
    expect(wrapperExemptions).toEqual(['packages/dev-view/src/browser/mini-preview.tsx'])
    expect(appearanceExemptions).toEqual([])
  })
})
