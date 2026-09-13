# Shared UI

Reusable Base UI/shadcn primitives and React controls for the HQ shell, scene
controls, room authoring, themes, drawers, loading states, and overlays. Scene
branding and Three.js runtime behavior stay in their owning packages.

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
