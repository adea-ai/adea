/*
 * Copyright (c) 2026 Wing
 * Licensed under the MIT License.
 *
 * Appearance miniatures substantially translated from Zeron
 * crates/ui/src/settings/appearance.rs (the `miniature`, `miniature_split`,
 * and `palette_preview` builders) with the option-card frame rhythm of
 * crates/ui/src/settings/widgets.rs (`option_card`), revision
 * 30a9a9537c5ec96226c87f4bf349b6f77c5dfb59: a sidebar-plus-pane miniature of
 * the real chrome painted from a variant's own colors, the split light/dark
 * half for System mode, and the three-band palette strip. Modified for
 * Adea's token roles (card/background/border/foreground/primary stand in for
 * the donor's surface/bg/border/text/accent) and for the accent default
 * sample, which shows the derived accent wash over foreground glyph bars.
 * See NOTICE and docs/research/dev-view-donor-audit.md.
 *
 * Like theme-swatch.tsx, these components are the sanctioned bridge between
 * runtime token data and the DOM: the colors they paint arrive as theme
 * manifest values, so painting them must inline them (token data may never
 * become a component color literal). The previewed variant's border color
 * travels through the `--preview-border` custom property consumed by the
 * `.theme-preview-border` hook in styles/theme.css.
 */
import type { JSX } from 'solid-js'

import type { ThemeVariant } from './appearance'

/** Which corners of the miniature round themselves (donor `Corners`). */
export type MiniatureCorners = 'all' | 'left' | 'right'

const cornerClass: Record<MiniatureCorners, string> = {
  all: 'rounded-md',
  left: 'rounded-l-md',
  right: 'rounded-r-md',
}

/** The glyph-bar ramp in the accent default sample (donor bar heights). */
const accentRamp: readonly { height: string; opacity: string }[] = Object.freeze([
  { height: '13px', opacity: '0.4' },
  { height: '16px', opacity: '0.7' },
  { height: '11px', opacity: '1' },
])

function Bar(props: { fraction: number; opacity: number; color: string }) {
  return (
    <span
      class="h-[5px] rounded-[3px]"
      // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
      style={{
        width: `${Math.round(props.fraction * 100)}%`,
        'background-color': props.color,
        opacity: props.opacity,
      }}
    />
  )
}

/**
 * The sidebar-plus-pane miniature of the app chrome, painted from one
 * variant: a sidebar of text bars beside a bordered content pane. (Zeron
 * `miniature`; bar rhythm and opacities preserved.)
 */
export function ThemeMiniature(props: {
  variant: ThemeVariant
  corners?: MiniatureCorners
  class?: string
}) {
  const colors = () => props.variant.colors
  return (
    <span
      data-theme-miniature
      class={`flex h-full w-full overflow-hidden ${cornerClass[props.corners ?? 'all']} ${props.class ?? ''}`}
      aria-hidden="true"
      // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
      style={{ 'background-color': colors().card }}
    >
      <span class="flex h-full w-11 shrink-0 flex-col gap-[7px] px-2 pt-3.5">
        <Bar fraction={0.7} opacity={0.34} color={colors().foreground} />
        <Bar fraction={1} opacity={0.22} color={colors().foreground} />
        <Bar fraction={0.85} opacity={0.22} color={colors().foreground} />
        <Bar fraction={1} opacity={0.22} color={colors().foreground} />
      </span>
      <span
        class="theme-preview-border my-2 mr-2 flex min-w-0 flex-1 flex-col gap-[7px] rounded-md border p-2.5"
        // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
        style={{ 'background-color': colors().background, '--preview-border': colors().border }}
      >
        <Bar fraction={0.62} opacity={0.34} color={colors().foreground} />
        <Bar fraction={0.88} opacity={0.22} color={colors().foreground} />
        <Bar fraction={0.76} opacity={0.22} color={colors().foreground} />
        <Bar fraction={0.52} opacity={0.22} color={colors().foreground} />
      </span>
    </span>
  )
}

/**
 * The System-mode card: the light and dark miniatures side by side, each
 * rounding only its outer corners. (Zeron `miniature_split`.)
 */
export function ThemeMiniatureSplit(props: {
  light: ThemeVariant
  dark: ThemeVariant
  class?: string
}) {
  return (
    <span class={`flex h-full w-full ${props.class ?? ''}`} aria-hidden="true">
      <span class="h-full w-1/2 overflow-hidden">
        <ThemeMiniature variant={props.light} corners="left" />
      </span>
      <span class="h-full w-1/2 overflow-hidden">
        <ThemeMiniature variant={props.dark} corners="right" />
      </span>
    </span>
  )
}

/**
 * The compact palette strip in a theme picker row: surface, background, and
 * accent thirds behind the variant's border. (Zeron `palette_preview`.)
 */
export function PalettePreview(props: { variant: ThemeVariant; class?: string }) {
  const bands = () => [
    props.variant.colors.card,
    props.variant.colors.background,
    props.variant.colors.primary,
  ]
  return (
    <span
      class="theme-preview-border flex h-[18px] w-[30px] shrink-0 overflow-hidden rounded-[5px] border"
      aria-hidden="true"
      // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
      style={{ '--preview-border': props.variant.colors.border }}
    >
      {bands().map((band) => (
        <span
          class="h-full w-1/3"
          // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
          style={{ 'background-color': band }}
        />
      ))}
    </span>
  )
}

/**
 * The "Theme default" accent sample: the derived accent wash with a ramp of
 * foreground glyph bars. (Zeron's accent-wash swatch; Adea derives the wash
 * from the accent roles and paints the glyph ramp with foreground opacities.)
 */
export function AccentDefaultSample(props: { variant: ThemeVariant; class?: string }): JSX.Element {
  const accent = () => props.variant.colors.primary
  const foreground = () => props.variant.colors.foreground
  return (
    <span
      class={`flex h-full w-full items-center justify-center gap-[2px] rounded-[6px] ${props.class ?? ''}`}
      aria-hidden="true"
      // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
      style={{ 'background-color': `color-mix(in srgb, ${accent()} 16%, transparent)` }}
    >
      {accentRamp.map((bar) => (
        <span
          class="w-1 rounded-[2px]"
          // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
          style={{ height: bar.height, 'background-color': foreground(), opacity: bar.opacity }}
        />
      ))}
    </span>
  )
}
