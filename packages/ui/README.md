# Application UI

This private package owns Adea's branding, persisted appearance adapter, and
host surface styles. Reusable controls come from the published
`@adea-ai/ui` package. Import its component subpaths directly; do not add another
local primitive or a forwarding barrel here. Scene branding and Three.js runtime
behavior stay in their owning packages. The Solid stack is recorded in
[decision 0007](../../docs/decisions/0007-solid-tanstack-start.md).

The root lint configuration also enforces the published consumer rules for
inline CSS and icon actions. Use shared `ActionButton` with a nonblank tooltip
and `aria-label` for icon-size actions; labelled text buttons may use `Button`.
Use component variants and documented layout hooks instead of inline style
props, literal style spreads, or style elements. The real Oxlint CLI regression
in `scripts/shared-ui-lint-config.test.ts` checks that these rules remain active.
The tooltip rule cannot prove dynamic tooltip content or an accessible name;
verify both in browser coverage rather than treating lint as an exception.

The branded `WorkspaceLogo` accepts only its layout class, image/presentation
role, and decorative `aria-hidden` state. It does not forward activation
handlers, tab stops, or arbitrary SVG props. Compose a shared control around
the mark when an action needs branding.

The unused local Toggle, ToggleGroup, RadioGroup, Tabs, Card, and Spinner copies
and their private exports have been removed. Workspace overlays and controls
compose published shared components; this package keeps only host preference
adapters, layout, branding, and surface policy.

Workspace dividers and plugin loading placeholders now use published Separator
and Skeleton directly. The persistent plugin count status reports loading and completion outside the
busy placeholder region. The shared Skeleton hides each decorative placeholder from assistive technology and
respects reduced motion. Existing layout hooks remain at their callers. Capability and plugin status
labels use published Badge with the same default, secondary, outline, and
destructive semantics; the private Badge implementation is removed. Plugin empty states use published
Empty composition, with caller layout preserving flexible list sizing; the
private Empty copy is removed. Room and conversation forms compose published Label and Input with native form
validation and published Alert for request failures. The private Field variant
system is removed; native `for` associations and form data remain at the domain callers. Shared Tooltip now supplies the
workspace status and toolbar hints. The host keeps its 200/300/300 ms timing,
arrow-free placement, and informational pointer transparency; the private Tooltip
implementation and unused class-variance-authority dependency are removed.

Workspace action and filter menus use published DropdownMenu, preserving their
placement, scroll bounds, action callbacks, and retained radio selections. The
private menu implementation and its appearance overrides are removed. The
remaining `lib/utils` compatibility path re-exports the shared class merger so
token-derived size overrides follow the shared design-system contract.

Workspace task detail drawers use the published Drawer, retaining their
controlled state, actions, keyboard dismissal, and focus restoration. Named
layout hooks bound their widths; the shared component supplies the scrim,
scrolling surface, and outward drag behavior. The copied Drawer and its private
exports and direct dependency have been removed.

VersionDialog is a thin Adea adapter to the published UpdateDialog. It maps
native update snapshots and forwards install version checks without owning the
generic renderer or release-note formatter. Controlled callers forward the
persistent opener accessor to the shared focus-restoration contract.

The theme-library contract view also uses the published ModalDialog. It keeps
the live appearance editor mounted beneath the nested dialog and restores its
Manage themes opener after Close or Escape without closing Settings or losing
the unsaved preview. The final copied Dialog primitives, private exports, and
unused direct Kobalte dependency have been removed.

Workspace dialogs use the published ModalDialog with their existing non-modal
Kobalte mode and product layout hooks. Shared background containment restores
previous inert states after dismissal or asynchronous close. The copied
workspace ModalDialog and its overlay/header appearance styles are removed.

## Theming contract: the published palette is the color authority

Components and consumer styles use semantic color roles from the published
`@adea-ai/ui/theme.css` and generated catalogue projections. Local shell and
status styles may alias those roles or derive translucent colors from them;
they do not declare color literals or override shared palette roles. The shell
stylesheet owns layout and host surface policy, while theme selection and every
light/dark palette come from the published `@adea-ai/themes` catalogue.

```css
/* Alias a shared semantic role when the consumer needs a local name. */
.notice {
  --notice-color: var(--info);
  color: var(--notice-color);
  border-color: color-mix(in srgb, var(--notice-color) 45%, transparent);
}
```

`scripts/check-theme-colors.mjs` enforces the rule across `packages/ui`,
`packages/workspace-ui`, `packages/dev-view`, and `apps/web/src`;
`scripts/theme-color-boundary.test.ts` also checks that every source stylesheet
under a `src` directory in `packages` or `apps` is covered by a configured scan root,
including nested hosts such as `apps/desktop/shell/src`,
and that each configured root still exists and contains eligible source. A new
CSS-bearing package therefore fails closed until its source root is reviewed.

The rule is a gate with a burn-down, not a rewrite:

- Files in `BASELINE` may carry an exact number of literals, each entry with a
  reason. Adding a literal fails the build, and so does removing one without
  updating the count, so the list only shrinks.
- `GENERATED_THEME_FILES` contains only exact outputs of
  `packages/ui/scripts/generate-canonical-theme-data.ts`; the package's
  `themes:check` command verifies those projections against the published
  package. App-authored sheets are scanned normally.
- CSS named colors are checked in color-bearing declaration values and custom
  properties. CSS-wide/semantic keywords, quoted strings, URLs, comments, and
  TS/TSX class-name strings are not treated as palette values.

Why it is worth a gate: with it, restyling is a token swap and dark mode is a
second set of declarations. Without it, every hardcoded value is a small rewrite
that nobody schedules.

The built-in palettes are the complete published `@adea-ai/themes` 0.8.1
catalogue, led by the `adea-light`/`adea-dark` pair. Every theme passes the host's
4.5:1 editor floor; no palette is waived. Build-time generation consumes the
published `@adea-ai/ui/lib/themes` framework projection plus the catalogue's
terminal/editor adapters. The generated stylesheet includes default and named
palettes, all sidebar/status/raised-surface roles, and renderer aliases. The
app-authored theme sheet contains host aliases, branding hooks, and surface
policy. The logo asset uses the published scrim contrast pair, and the shell
mark uses the selected palette's primary pair. The shell no longer replaces
the selected catalogue palette with a hand-authored light/dark palette.
A scanner regression rejects palette literals in consumer properties and
direct overrides of shared color roles.

The mode selector uses the published controlled `ThemeModeToggle`; its selected
mode still comes from the host's persisted preference provider. The pre-paint
script resolves the saved theme attribute without embedding palette data. V2
preference persistence, custom-theme recovery, native surface capability, and reduced transparency remain host adapters. Unknown or removed
catalogue IDs resolve to the default of the same appearance and the original
stored record is preserved. Run `bun run --cwd packages/ui themes:generate`
after changing the published source; `bun run --cwd packages/ui themes:check`
verifies the committed generated files are current.

The unused AccountDrawer, SceneSettings, and OnScreenControls copies and their test-only harnesses are removed. The global account menu composes the published AccountMenu. The external Agent Sim scene engine owns its live scene settings and movement controls and depends on published UI, not this private package. The app retains its `data-agent-hq-on-screen-controls` viewport positioning hook for that engine. Do not restore these unused copies or add generic controls to the host adapter package.
