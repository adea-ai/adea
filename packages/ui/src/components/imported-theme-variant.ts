/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 */
import {
  chartSeries,
  shadcnDestructiveProjection,
  shadcnVariables,
  statusForeground,
  syntaxRoles,
  tint,
  type AdeaThemeRecord,
} from '@adea-ai/themes'

import type {
  ThemeColors,
  ThemeEditorPalette,
  ThemeTerminalPalette,
  ThemeVariant,
} from '@adea-ai/ui/lib/themes'

/**
 * The shared variant of one catalogue-shaped record: the projection the published
 * `variantFromRecord` of `@adea-ai/ui/lib/themes` computes, without importing that
 * module.
 *
 * Why this is here: `lib/themes.ts` also holds the 34-theme table, and a bundler
 * places a module whole. The shell builds an imported theme's variant at start-up
 * (the provider needs the registry before its first resolution), so importing
 * `variantFromRecord` from there put the whole catalogue back into the start-up
 * chunk (ADR 0014). This copy imports only the catalogue's code, never its data.
 * `imported-theme-variant.test.ts` pins it to the published function, so a change
 * to the shared projection fails there instead of drifting. It goes when the shared
 * package exports `variantFromRecord` from a module of its own.
 */
export function importedVariantFromRecord(theme: AdeaThemeRecord): ThemeVariant {
  return {
    id: theme.id,
    family: theme.family,
    familyLabel: theme.familyLabel,
    label: theme.label,
    appearance: theme.appearance,
    description: theme.description,
    colors: colorsOf(theme),
    terminal: terminalOf(theme),
    editor: editorOf(theme),
    chart: chartSeries(theme),
    provenance: {
      source: theme.provenance.project,
      url: theme.provenance.url,
      license: theme.provenance.license,
    },
  }
}

function colorsOf(theme: AdeaThemeRecord): ThemeColors {
  const projected = shadcnVariables(theme)
  const token = (name: string): string => {
    const value = projected[`--${name}`]
    if (!value) throw new Error(`${theme.id} has no shared shadcn projection for --${name}`)
    return value
  }
  const destructiveAction = shadcnDestructiveProjection(theme)
  return {
    background: token('background'),
    foreground: token('foreground'),
    card: token('card'),
    cardForeground: token('card-foreground'),
    popover: token('popover'),
    popoverForeground: token('popover-foreground'),
    primary: token('primary'),
    primaryForeground: token('primary-foreground'),
    secondary: token('secondary'),
    secondaryForeground: token('secondary-foreground'),
    muted: token('muted'),
    mutedForeground: token('muted-foreground'),
    accent: token('accent'),
    accentForeground: token('accent-foreground'),
    destructive: theme.colors.error,
    destructiveForeground: statusForeground(theme, 'error'),
    destructiveSubtle: tint(theme.colors.error, theme.colors.background),
    destructiveAction: destructiveAction.fill,
    destructiveActionForeground: destructiveAction.foreground,
    success: token('success'),
    successForeground: statusForeground(theme, 'success'),
    successSubtle: tint(theme.colors.success, theme.colors.background),
    warning: token('warning'),
    warningForeground: statusForeground(theme, 'warning'),
    warningSubtle: tint(theme.colors.warning, theme.colors.background),
    info: token('info'),
    infoForeground: statusForeground(theme, 'info'),
    infoSubtle: tint(theme.colors.info, theme.colors.background),
    border: token('border'),
    input: token('input'),
    ring: token('ring'),
    sidebar: token('sidebar'),
    sidebarForeground: token('sidebar-foreground'),
    sidebarAccent: token('sidebar-accent'),
    sidebarBorder: token('sidebar-border'),
    sidebarMutedForeground: token('sidebar-muted-foreground'),
  }
}

function terminalOf(theme: AdeaThemeRecord): ThemeTerminalPalette {
  return {
    background: theme.colors.background,
    foreground: theme.colors.foreground,
    cursor: theme.cursor,
    selection: theme.selection,
    ...theme.ansi,
  }
}

function editorOf(theme: AdeaThemeRecord): ThemeEditorPalette {
  const syntax = syntaxRoles(theme)
  return {
    keyword: syntax.keyword,
    string: syntax.string,
    number: syntax.number,
    comment: syntax.comment,
    function: syntax.function,
    variable: syntax.variable,
    type: syntax.type,
    tag: syntax.tag,
    attribute: syntax.attribute,
    operator: syntax.operator,
    heading: syntax.heading,
    link: syntax.link,
    diffAdd: syntax.diffAdd,
    diffDelete: syntax.diffDelete,
    diffHunk: syntax.diffHunk,
    searchMatch: syntax.searchMatch,
  }
}
