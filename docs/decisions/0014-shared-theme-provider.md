# Run Adea on the Shared Theme Provider

- Status: Accepted (2026-10-13).
- Date: 2026-10-13
- Extends: [ADR 0007](0007-solid-tanstack-start.md) (the Solid stack and the
  published UI system) and [ADR 0010](0010-performance-budgets-and-gates.md)
  (bundle budgets, which this change must not break).
- Scope: which package owns appearance resolution and the document it writes,
  what Adea keeps as its own, and what is guaranteed about data users already
  have.

## Context

Adea carried its own `ThemeProvider` beside the published one in
`@adea-ai/ui`. The two implemented the same rules twice: resolving a mode to a
theme, painting the document, deriving accent roles and their contrast, and
generating a palette stylesheet. Adea also generated about 240 KB of palette
data (`canonical-themes.css` and the compact data behind it) that the shared
package could compute. Cortana needed the same capabilities (a terminal pin,
translucent surfaces, imported themes, font zoom) and could not adopt a
provider that lacked them.

The shared provider has since gained, additively and off by default, a
persistence seam, host themes and a draft preview, accent roles with a
contrast floor, the surface axis, a pinned terminal palette, font-zoom chords,
a stylesheet palette mode, a versioned preference store and a boot script
rendered from a storage schema. Cortana's props and stored bytes are unchanged.

## Decision

Adea runs the published provider (its lazy entry, see Consequences), pinned to an exact `@adea-ai/ui` version in
every manifest that depends on it. Reusable behaviour lives there; Adea keeps
only what is product schema or product capability, in three modules in
`packages/ui/src/components`:

- `appearance-codec.ts` is the stored V2 document: the keys `appearance`,
  `appearance.library`, `appearance.recovery` and the legacy `theme`, the field
  set and its normalization, the legacy migration, the fresh-install defaults
  (the Violet accent), and the mapping between a V2 preference and the
  provider's selection. The same schema object renders the boot script and
  configures the persistence, so first paint and the mounted provider read one
  document.
- `custom-theme-library.ts` is the imported-theme library: its stored shape,
  validation, the in-memory registry and its subscription, and a recovery key of
  its own, `appearance.library.recovery`.
- `appearance-host.tsx` configures the provider (persistence, imported themes,
  surface policy and the native-translucency capability, an accent contrast
  floor of 3:1, the editor-floor projection, hex tokens, font zoom) and exposes
  the V2 `update` and `preview` seam the appearance editor writes through. The
  shell reads the shared context itself (`useOptionalTheme` of
  `@adea-ai/ui/components/theme`: the selection, the resolved appearance, the
  variant and `accentRolesFor`); no compatibility copy of it remains.

The catalogue palettes are painted by the published
`@adea-ai/ui/theme-variants.css`; Adea's generated duplicates and the generator
are deleted. The document contract follows the shared provider: the root
carries `data-appearance` (replacing `data-appearance-mode`), and `data-accent`
holds the preset id, `custom` for a `#rrggbb` accent, and nothing for a
theme-derived accent until the provider mounts.

### Data safety

The stored bytes do not change. A document written before this change is read
as it was, and a write produces the same fields in the same order; `fonts` is
written only when the stored document carried it or the text settings differ
from the defaults, so an untouched document keeps its bytes. Unreadable or
wrong-version records are quarantined byte for byte before any write can reach
the main key, the legacy `theme` key is read only while `appearance` is absent
and is never deleted, and saved imported themes keep their stored shape and
their flat token map, which is still painted verbatim. The library no longer
shares `appearance.recovery`, so a corrupt library cannot overwrite the
preference's quarantine. There is no feature flag; rollback is a revert.

### Accepted differences

- Computed palette tokens are the catalogue's own notation (oklch) where Adea
  wrote hex; the provider writes inline accent and imported-theme tokens as hex.
- A theme-derived (`ansi-*`) accent follows the shared semantics, and the
  accent hover and subtle tint follow the shared roles.
- A custom accent keeps one stored spelling, `#rrggbb`; an alpha channel is
  dropped on read.
- An open appearance draft stays on screen when a committed change (the mode
  toggle, a zoom chord) ends the shared preview; the host re-applies it until
  the editor ends it.

## Consequences

Adea's theming code shrinks to the host seams, the palette is defined once, and
Cortana and Adea share one document contract. Adea inherits the published
package's release cadence for theming changes and must bump the pinned version
deliberately.

The shell imports the provider from the published lazy entry,
`@adea-ai/ui/components/theme/lazy`, and so does every consumer of the shared
context (`useOptionalTheme`, `ThemeModeToggle`, the codec's persistence helpers):
the lazy and eager entries share one context object (a registered global symbol),
but importing the eager entry anywhere in the start-up graph would bring the whole
34-theme catalogue back. Until the catalogue loads, `useTheme().themes` and
`allThemes()` list only the default pair, `variant()` is the default of the
appearance, and the document keeps what `themeScript` and `theme-variants.css`
painted. The provider fetches the catalogue itself when the saved or previewed
selection names a theme beyond the default pair; the appearance editor also calls
`loadCatalogue()` when it mounts. A saved imported theme is not a catalogue theme:
it resolves at once from the library and pre-paints from its stored flat tokens.

Two host rules keep the catalogue out of the start-up chunk, because a bundler
places a module whole. `themeRegistry` (the one reader of `builtinThemes`) lives in
`theme-registry.ts`, imported only by the lazy appearance editor, not in
`custom-theme-library.ts`; and the start-up code imports nothing defined in
`@adea-ai/ui/lib/themes` beside the table: not `accents` (read
`@adea-ai/ui/lib/accent-presets`) and not `variantFromRecord` (read
`@adea-ai/ui/lib/theme-records`; both are published from modules of their own
since 0.128.4, which retired the host copy and its parity test). The bundle gate
(`scripts/client-bundle-budgets.mjs`) fails if a catalogue display name appears in
the start-up closure, and a boundary test fails on the imports above.
