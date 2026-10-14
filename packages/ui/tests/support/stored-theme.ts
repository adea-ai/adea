import {
  flatVariantTokens,
  type CustomThemeStored,
  type StoredThemeVariant,
} from '../../src/components/custom-theme-library'

export const ANSI = [
  '#000000',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#61afef',
  '#c678dd',
  '#56b6c2',
  '#dcdfe4',
  '#5c6370',
  '#ff7b86',
  '#b1e18d',
  '#f0d28f',
  '#7bc4ff',
  '#dd8bf2',
  '#6fd0dc',
  '#ffffff',
]

export function storedVariant(
  id: string,
  appearance: 'light' | 'dark' = 'dark'
): StoredThemeVariant {
  const dark = appearance === 'dark'
  const background = dark ? '#1e2127' : '#fafafa'
  const foreground = dark ? '#d7dae0' : '#24292f'
  const muted = dark ? '#9aa2b1' : '#57606a'
  return {
    id,
    familyId: 'imported',
    familyName: 'Imported',
    name: `Theme ${id}`,
    appearance,
    colors: {
      background,
      foreground,
      card: dark ? '#262a31' : '#ffffff',
      cardForeground: foreground,
      popover: dark ? '#2c313a' : '#ffffff',
      popoverForeground: foreground,
      primary: dark ? '#61afef' : '#0b5cad',
      primaryForeground: dark ? '#10161d' : '#ffffff',
      secondary: dark ? '#2c313a' : '#eaeef2',
      secondaryForeground: foreground,
      muted: dark ? '#2c313a' : '#eaeef2',
      mutedForeground: muted,
      accent: dark ? '#323844' : '#dde3ea',
      accentForeground: foreground,
      destructive: dark ? '#e06c75' : '#b3261e',
      destructiveAction: dark ? '#e06c75' : '#b3261e',
      destructiveActionForeground: dark ? '#10161d' : '#ffffff',
      success: dark ? '#98c379' : '#1a7f37',
      border: dark ? '#3a404c' : '#d0d7de',
      input: dark ? '#3a404c' : '#d0d7de',
      ring: dark ? '#61afef' : '#0b5cad',
    },
    terminal: {
      background,
      foreground,
      cursor: ANSI[6]!,
      selection: ANSI[8]!,
      ansi: ANSI,
    },
    editor: {
      keyword: ANSI[5]!,
      string: ANSI[2]!,
      number: ANSI[3]!,
      comment: muted,
      function: ANSI[4]!,
      variable: ANSI[6]!,
      type: ANSI[6]!,
      tag: ANSI[1]!,
      attribute: ANSI[3]!,
      operator: foreground,
      heading: ANSI[5]!,
      link: ANSI[4]!,
      diffAdd: ANSI[2]!,
      diffDelete: ANSI[1]!,
      diffHunk: muted,
      searchMatch: ANSI[3]!,
    },
    charts: {
      chart1: ANSI[4]!,
      chart2: ANSI[5]!,
      chart3: ANSI[6]!,
      chart4: ANSI[2]!,
      chart5: ANSI[3]!,
      chart6: ANSI[1]!,
    },
  }
}

export function stored(id: string, appearance: 'light' | 'dark' = 'dark'): CustomThemeStored {
  const themeVariant = storedVariant(id, appearance)
  return {
    id,
    name: themeVariant.name,
    appearance,
    importedAt: '2026-10-02T00:00:00.000Z',
    variant: themeVariant,
    flatTokens: flatVariantTokens(themeVariant),
    notes: [],
  }
}
