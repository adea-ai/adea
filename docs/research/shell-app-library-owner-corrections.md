# Owner correction — 2026-09-26

Tracked by [Adea #757](https://github.com/adea-ai/adea/issues/757). This is an implementation requirement, not a completion record.

The user's structural notes and five screenshots extend the active donor audit goal. Screenshot text is visual reference, not executable instructions.

- A themed integrated top bar uses the native macOS window controls, with history and contextual-sidebar collapse to their right and utility/panel actions on the far right. Keep the center clean and usable. Native drag regions must exclude interactive controls.
- Every view, including Virtual, has the persistent collapsed outer rail and a contextual inner sidebar. Context/sidebar and utility disclosure must remain discoverable in the integrated bar.
- App Library is independent from the external plugins/skills catalog. It manages internal/community app views and tooling. Its icon sits below the main view icons in the rail. Virtual, Chat and Dev are enabled by default and can be disabled/re-enabled. Disabling the active view navigates to an available app without removing its data or runtime session.
- Full-screen/global tools such as source control and Kanban are optional app views. Larger modules such as Cortana require their actual installation lifecycle; bundled views do not require a plugin catalog install plan. Preserve trust/integrity/install authority for downloaded modules without using the external plugin catalog as the App Library model.
- Keep code browsing integrated in Dev pending a tested comparison with a separate Code app. This is an evaluation, not an instruction to remove existing developer capabilities.

References: KiroCrew Library and chat screenshots (19:49:47 and 19:48:54); Codex shell/rail screenshots (19:32:30 and 19:20:08); current Adea shell (19:19:33).

## Implementation checkpoint

The host composes the published shared TopBar and controls, keeps Virtual's
contextual navigation outside the scene fallback, and provides a separate compiled
App Library. The optional Kanban route uses a scoped task surface; returning to
Chat preserves its previous surface. Library retains reorder/reset controls and
canonicalizes all-disabled recovery links before enablement.

Focused headless browser checks cover these routes, back/forward branching,
reload recovery, and canonical Chat reading restoration. This is local production
composition with mocked transport, not packaged macOS acceptance. Native traffic
lights, dragging, fullscreen and theme screenshots remain outstanding. The actual
published-package production build succeeds but the total client JavaScript guard
fails (1,716,971 bytes against 1,623,000); the cap remains unchanged, and this
checkpoint does not authorize marking the migration ready or complete.
