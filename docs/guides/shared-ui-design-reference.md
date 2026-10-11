# Shared UI design reference

The [Adea UI design artifact](https://claude.ai/artifact/BRWYnXVxsBF1w98d6M9KWs)
is a visual reference for every coding agent, including Codex. It was inspected
in the authenticated Claude desktop app on 2026-10-03. Claude authentication may
be required; the artifact is reference material, not an agent-specific policy.

Use its component examples to compare surfaces, typography roles, control
density, borders, icon sizing, named overlay layers, and shared shell regions.
The installed published `@adea-ai/ui` and `@adea-ai/themes` packages, their
contracts, and this repository's lint rules remain the implementation authority.
Do not copy the artifact's component or palette implementations into Adea.

## Apply the reference to the current product

- Keep the global app rail available in every view. Room and Character design
  hide both contextual sidebars and their collapse toggles. Contextual content
  belongs to the active view; its container, resizing, and collapse behavior
  remain shared.
- Use shared `Heading` and `Text` roles, semantic surface/status tokens, and
  component variants. Consumer classes describe layout; missing appearance
  variants are implemented in the shared UI package.
- Use shared `ActionButton` for icon actions with a meaningful tooltip and an
  accessible name. Hover descriptions must also be reachable with keyboard
  focus. Never convey a state through color alone.
- Keep accent choices sourced from the selected theme. The appearance picker
  has six choices in two rows of three: the theme default and five alternate
  theme-provided accents. Do not hard-code a palette from the artifact.
- Follow the current three-axis font requirement: UI and Content default to
  System at 14px; Code defaults to System at 12px. Each chooser starts with
  System, followed by a divider and available fonts. The artifact's single
  `data-font` axis and Space Grotesk default describe an earlier state.
- Fonts are self-hosted by the shared UI package. Default System must not
  download optional font faces. Verify selected faces, fallback behavior, and
  legible control geometry after a user changes font family or size.

## Verify a change

Run the consumer lint rules without adding exemptions, type checking, affected
behavior tests, and production bundle gates. For visual changes, inspect the
actual app at desktop and narrow widths, in light and dark themes, with keyboard
focus and reduced motion. Shared library changes also require packed-consumer
and tree-shaking evidence. A design artifact or component preview alone does
not establish app fidelity or accessibility.
