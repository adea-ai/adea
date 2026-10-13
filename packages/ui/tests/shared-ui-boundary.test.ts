import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string) => readFileSync(join(import.meta.dir, '../src', path), 'utf8')
const repositoryFile = (path: string) =>
  readFileSync(join(import.meta.dir, '../../..', path), 'utf8')

describe('private application UI boundary', () => {
  test('delegates mode selection and roving focus to the published controlled toggle', () => {
    const toggle = source('components/theme-toggle.tsx')
    expect(toggle).toContain(
      "import { ThemeModeToggle, useTheme } from '@adea-ai/ui/components/theme'"
    )
    expect(toggle).toContain('mode={theme.selection().appearance}')
    expect(toggle).toContain('theme.setSelection({ appearance })')
    expect(toggle).not.toContain('role="radio"')
  })

  test('shell code reads the shared theme context, not a host copy of it', () => {
    const consumers = [
      'apps/web/src/components/workspace-navigation.tsx',
      'packages/workspace-nav/src/workspace-nav.tsx',
      'packages/workspace-ui/src/workspace-identity-settings.tsx',
      'packages/workspace-ui/src/workspace-settings.tsx',
      'packages/ui/src/components/workspace-identity-mark.tsx',
    ]
    for (const path of consumers) {
      const code = repositoryFile(path)
      expect(code).toContain("from '@adea-ai/ui/components/theme'")
      expect(code).not.toContain('components/theme-provider')
    }
    // The host view keeps only the V2 seam the appearance editor writes through.
    const host = source('components/appearance-host.tsx')
    for (const name of [
      'resolvedTheme',
      'setTheme',
      'variantId',
      'resolvedMode',
      'preferences: Accessor',
    ]) {
      expect(host).not.toContain(name)
    }
    expect(host).not.toContain('export function useOptionalTheme')
    expect(source('components/workspace-accent.ts')).not.toContain('variantId')
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
    // The surface amounts and the frosted dialog rule belong to the published theme.
    expect(theme).not.toContain("[data-surface='frosted'] [role='dialog']:not([data-variant])")
    expect(theme).not.toContain('--surface-alpha:')
    expect(theme).not.toContain('--surface-frost')
    expect(theme).toContain("[data-surface='translucent'] .conventional-workspace")
    expect(theme).not.toContain('button:not(:disabled)')
    expect(theme).not.toContain('border-color: var(--border)')
    expect(theme).not.toContain('background: var(--background)')
  })

  test('does not override shared controls through broad workspace descendant resets', () => {
    const workspace = source('styles/conventional-workspace.css')
    expect(workspace).not.toMatch(
      /\.conventional-workspace\s+(?:button|input|select|textarea|svg|h[1-6]|p|:focus-visible)\b/
    )
    expect(workspace).not.toContain('font-family: Inter,')
    expect(workspace).toContain('font-family: var(--font-ui, var(--font-sans))')
  })

  test('keeps consumer controls and appearance free of path exemptions', () => {
    type Override = { files: string[]; rules: Record<string, string> }
    const config = JSON.parse(repositoryFile('.oxlintrc.json')) as { overrides?: Override[] }
    const overrides = config.overrides ?? []
    const rawInteractiveExemptions = overrides.flatMap(({ files, rules }) =>
      rules['adea/no-raw-interactive-elements'] === 'off' ? files : []
    )
    const wrapperExemptions = overrides.flatMap(({ files, rules }) =>
      rules['adea/no-interactive-wrappers'] === 'off' ? files : []
    )
    const appearanceRules = [
      'shadcn/no-restyle',
      'shadcn/no-arbitrary-values',
      'shadcn/no-inline-styles',
      'shadcn/require-static-classes',
    ]
    const appearanceExemptions = overrides.flatMap(({ files, rules }) =>
      appearanceRules.some((rule) => rules[rule] === 'off') ? files : []
    )

    expect(rawInteractiveExemptions).toEqual([])
    expect(wrapperExemptions).toEqual([])
    expect(appearanceExemptions).toEqual([])
  })
})
