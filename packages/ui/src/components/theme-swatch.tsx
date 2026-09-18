import { For } from 'solid-js'

import type { ThemeVariant } from './appearance'

/*
 * Preview swatches for the appearance pickers: small role-colored dots so a
 * palette can be previewed without applying it. Colors arrive as runtime
 * token data from the theme manifest, so painting them must inline them —
 * this component is the one sanctioned bridge between token data and the DOM
 * (token data may never become a component color literal).
 */

/** The three-dot preview for a theme variant (background, primary, card). */
export function ThemeSwatch(props: { class?: string; variant: ThemeVariant }) {
  const swatches = () => [
    { role: 'Background', color: props.variant.colors.background },
    { role: 'Primary', color: props.variant.colors.primary },
    { role: 'Card', color: props.variant.colors.card },
  ]
  return (
    // Decorative next to the variant name; the dots duplicate information the
    // adjacent text already gives assistive technology.
    <span class={props.class} aria-hidden="true">
      <For each={swatches()}>
        {(swatch) => (
          <span
            class="theme-swatch__dot"
            title={swatch.role}
            // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
            style={{ 'background-color': swatch.color }}
          />
        )}
      </For>
    </span>
  )
}

/** Single-color swatch (accent presets and custom accents). */
export function ColorSwatch(props: { class?: string; color: string; label: string }) {
  return (
    <span class={props.class} role="img" aria-label={props.label}>
      <span
        class="theme-swatch__dot"
        // oxlint-disable-next-line no-inline-styles -- dynamic token data, see file docstring
        style={{ 'background-color': props.color }}
      />
    </span>
  )
}
