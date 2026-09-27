# Application UI

This private package owns Adea's scene controls, branding, account composition,
and persisted appearance adapter. Reusable controls come from the published
`@adea-ai/ui` package. Import its component subpaths directly; do not add another
local primitive or a forwarding barrel here. Scene branding and Three.js runtime
behavior stay in their owning packages. The Solid stack is recorded in
[decision 0007](../../docs/decisions/0007-solid-tanstack-start.md).

The unused local Toggle, ToggleGroup, RadioGroup, Tabs, Card, and Spinner copies
and their private exports have been removed. Remaining local overlays and workspace controls are migration work: preserve their current focus,
inertness, and placement contracts while replacing them with shared components.

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

Account and task detail drawers use the published Drawer, retaining their
controlled state, actions, keyboard dismissal, and focus restoration. Named
layout hooks bound their widths; the shared component supplies the scrim,
scrolling surface, and outward drag behavior. The copied Drawer and its private
exports and direct dependency have been removed.

VersionDialog is a thin Adea adapter to the published UpdateDialog. It maps
native update snapshots and forwards install version checks without owning the
generic renderer or release-note formatter. Controlled callers forward the
persistent opener accessor to the shared focus-restoration contract. The private Dialog remains while
appearance compositions still depend on it.

Workspace dialogs use the published ModalDialog with their existing non-modal
Kobalte mode and product layout hooks. Shared background containment restores
previous inert states after dismissal or asynchronous close. The copied
workspace ModalDialog and its overlay/header appearance styles are removed.

## Theming contract: CSS custom properties are the only color surface

Components in this package never contain a color literal. Colors come from the
token layer (`src/styles/theme.css` for the shadcn tokens, `workspace-shell.css`
for the HQ shell tokens, `auth-shell.css` for the auth shell), and a component
that needs a new color adds a token instead of a value.

A color literal is legal in exactly one place: the **declaration** of a custom
property.

```css
/* A new token, declared once. */
--hq-shell-notice: #d97706;

/* Then used everywhere it is needed. */
.notice {
  color: var(--hq-shell-notice);
  border-color: color-mix(in srgb, var(--hq-shell-notice) 45%, transparent);
}
```

`scripts/check-theme-colors.mjs` enforces the rule across `packages/ui`,
`packages/workspace-ui` and `apps/web/src`;
`scripts/theme-color-boundary.test.ts` runs the scan in the validation lane.

The rule is a gate with a burn-down, not a rewrite:

- Files in `BASELINE` may carry an exact number of literals, each entry with a
  reason. Adding a literal fails the build, and so does removing one without
  updating the count — so the list only shrinks.
- `TOKEN_FILES` are the declared token layers, where a literal _is_ the theme.
- Named colors (`white`, `transparent`) are out of scope; the gate targets
  explicit literals.

Why it is worth a gate: with it, restyling is a token swap and dark mode is a
second set of declarations. Without it, every hardcoded value is a small rewrite
that nobody schedules.

The built-in `adea-light` and `adea-dark` palettes come from the published
`@adea-ai/themes` catalogue. The build-time
`scripts/generate-canonical-theme-data.ts` command converts its OKLCH schema and
derived terminal, syntax, and chart roles into generated records. The runtime
`src/components/canonical-theme-adapter.ts` consumes those records with the
existing CSS token names and no-flash authority. Run
`bun run --cwd packages/ui themes:generate` after changing the published source;
`bun run --cwd packages/ui themes:check` verifies the committed generated files
are current. The legacy `slate-*` and `contrast-*` preference IDs remain local
compatibility variants until matching catalogue records exist.
