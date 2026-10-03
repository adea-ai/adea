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
composition with mocked transport. Actual Settings-driven dark/light desktop and narrow-layout screenshots pass.
A packaged macOS build with an explicit loopback UI transport fixture verifies
the native traffic lights, zoom and fullscreen/return, integrated toolbar
sidebar/history actions, separate Library and Virtual contextual navigation.
Its normal production-origin counterpart builds but cannot mount the workspace
while the guest service is unavailable. Window dragging and production backend
acceptance are not attested by this fixture. A native accessibility inspection
found clipped Chat navigation still focusable when collapsed; the regression
fails before the visibility fix and passes afterward at desktop and narrow
widths. Final packaged WKWebView inspection confirms that the closed Chat sidebar
is absent from its accessibility tree and returns on expansion. The test app and
loopback fixture are stopped, with both listening ports verified closed.
The room-designer entry also retains Virtual's contextual sidebar; its browser
regression verifies collapse/expansion, persistent rail and return to Chat.
The actual
published-package production build succeeds but the total client JavaScript guard
fails; the cap remains unchanged, and this
checkpoint does not authorize marking the migration ready or complete.

A clean canonical CLI build at the Search/focus checkpoint measured 1,718,369
bytes, still above the 1,623,000-byte cap. This supersedes the instrumented build's
1,706,381-byte estimate: that diagnostic runner did not disable config auto-load,
so it cannot qualify the standard build. The attempted pure decoder-table
annotation did not improve the canonical output and was removed. All-disabled
Library recovery focuses its own search field and keeps same-route navigation
idempotent.

Returning desktop Chat now shares Dev's canonical selected session and donor
contextual sidebar. Three focused browser cases mount the actual desktop Chat
entry with a typed runtime transport: draft retention across Dev remount,
late-selection fencing, and refused-attach retry. These are local composition
checks, not packaged daily-driver certification or input-authority acceptance.

The returning-Chat standard production build measures 1,721,429 bytes against
the unchanged 1,623,000-byte cap. Full affected unit suites pass 570 tests
(1,741 assertions), and affected type checking passes 16 tasks. Independent
review found no remaining blocker in the returning-Chat slice. Three returning
Chat browser cases now use production styles without a fixture height override
and verify full-height layout and contextual sidebar paint.

The integrated metadata/search/reorder checkpoint at `ae26f52e` builds through
the normal production pipeline with actual npm UI `0.67.1` and measures
1,639,555 client JavaScript bytes. The unchanged cap is 1,623,000, leaving
16,555 bytes unresolved. Browser code now consumes generated lean operation
metadata and shared strict wire/DTO codecs; the full request DSL remains in
server validation. Registry/strict-decoding and docs checks pass 41 tests
(507 assertions). This supersedes the earlier 1,721,429-byte measurement for
the current integrated source, without changing the performance contract.

Library reorder now crosses disabled/unknown entries by one enabled rail slot,
preserving their stored positions. Its actual browser regression covers
disable, move, boundary controls, reload and re-enable. Returning Chat sidebar
search filters canonical group/project/session labels locally, reveals matching
ancestors and restores prior collapse state; its browser regression preserves
selected identity and the runtime operation log. Both regressions pass headlessly.
The combined filter/rail/docs focused suite passes 30 tests (86 assertions).
Independent MAX review finds no blocker in either correction.

## Owner amendment — 2026-10-01

This amendment supersedes only the 2026-09-26 bullet that placed utility/panel
actions on the far right. The earlier screenshot notes and implementation
checkpoints above remain historical evidence for their recorded source states;
they are not rewritten or promoted to evidence for this amendment.

- While Dev owns the active surface, its left-slot collapse/reopen, split-pane,
  and reopen-closed-pane actions begin after a divider aligned with the actual
  contextual sidebar edge. When that sidebar is collapsed or hidden, the
  divider follows the later of the rail edge and the leading history/context
  controls, so the two action groups never overlap. At phone widths the
  contextual sidebar is an overlay below the top bar, so Dev actions remain in
  top-bar flow after the contextual controls.
- The Files/Source Control choice belongs inside the left utility pane. Its
  top-bar action only collapses or reopens that slot. The right utility
  collapse/reopen control remains trailing and available while its pane is
  full width. Both slot toggles and the contextual sidebar control use the
  published outline icon-button treatment; the Files toggle uses FolderTree.
  Split and reopen use published ghost icon buttons, and the disabled New
  session placeholder is removed.
- These are Dev-owned controls. The user has separately confirmed that the
  Browser sidebar must be available from Chat, Dev, and Virtual. A shell-owned
  cross-view utility mount is a follow-up; this Dev-scoped implementation does
  not establish that requirement as complete. Preserve the trailing toggle
  mount contract for that integration.

Local source evidence for pane reopen: close and undo mutate the window's
published split-layout model; the closed-pane stack is not serialized with
session layout preferences. Closing a terminal pane disposes its local renderer
and stream attachment but does not call session archive/cancel or terminal
stop/create operations. Reopening a bound leaf can attach the same selected
live terminal from sequence zero, subject to runtime history retention. These
source findings are not packaged/native acceptance. A focused production-entry
Playwright regression is authored for the same-terminal/no-stop behavior, but
was not run in this worker lane; integration browser evidence remains pending.

## Verification checkpoint — 2026-10-03

Branch `feat/757-window-toolbar-app-library`, first at `a47a3fbb` and then
rebased onto `c2592cb0` (the toolchain/dependency update) with no
shell-chrome source change: the correction's acceptance is already carried by
the merged slices, so this checkpoint records the fresh verification pass, its
residual findings, and the one evidence-lane addition. It is local
production-composition evidence on the dev server; it is not packaged/native
certification, and window dragging and the production backend lane remain
unattested here as before.

Acceptance-to-implementation evidence, all read at this revision: the themed
integrated bar composes the published `TopBar` with `window-drag`/
`window-no-drag` and the macOS traffic-light inset (`workspace-top-bar.tsx`),
history and the contextual-sidebar toggle lead, runtime-resource, appearance
and notification actions trail, and Dev portals its pane controls into the
trailing mount; Virtual keeps the persistent rail and its contextual room
navigation (`workspace-shell.tsx`, `virtual-room-controls.tsx`); the rail
carries the Library icon below the workspace views with a separate Plugins
entry (`global-workspace-rail.tsx`); enablement stays a compiled,
catalog-independent rail-preference record with recovery, unknown-id
preservation, and quarantine (`workspace-apps.ts`, `rail-preferences.ts`,
`workspace-navigation.tsx`); activation authority and install-plan integrity
stay fail-closed for external catalog records (`app-library.ts`); and the
spec section in `docs/specs/dev-runtime.md` documents the same contract.

Fresh checks on this worktree: `bun test --conditions=browser tests/unit` in
`packages/workspace-ui` passes 104 tests; the web unit suite passes 183;
`bun run lint` reports 0 warnings and 0 errors (16 turbo tasks plus the root
scan); `bun run format:check` is clean; `bun run typecheck` passes 28 tasks;
`bun run build` passes 14 tasks including the web client build and the
Tailwind-sources verification; all of these were re-run green after the
rebase onto `c2592cb0`. Headless Playwright over a worktree dev server
on an isolated port passes the App Library navigation pair, the desktop
session-continuity quartet (draft retention across Dev remount, late-attach
fencing, refused-attach retry, single mounted session), the production
navigation presentation probe, the cursor and tooltip gates, the guest and
workspace-menu gates, and the workspace chrome/library gates including the
new reduced-settings capture, the Library/Plugins separation and all-off
recovery journey, the history traversal branch truncation, the Virtual
integrated-chrome and room-designer gates, and the optional
Kanban/Source-control journey (the last re-confirmed in isolation after one
contended batch run). Install/enable persistence and
session-continuity evidence remains carried by named tests, not by visual
fixtures: `disabled views remain recoverable through the separate Library`, `a
disabled requested view selects an enabled destination`, `all-off stale links
remain in Library while enabling the first app`, `Rail drag-and-drop reorders
views across disabled apps and persists after reload`, `App Library enables
views separately from Plugins and remains reachable with all apps disabled`,
and the desktop-runtime-chat quartet above.

Residual findings, recorded deliberately: first, six `-darwin` pixel
baselines for `workspace-room-populated-light`, `workspace-switcher`,
`workspace-direct-agent`, `workspace-appearance-popover-light`,
`workspace-settings-light`, and `appearance-panel-light` mismatched at roughly
0.01% of pixels at `a47a3fbb` on an otherwise unmodified worktree, so the
resting rendered output has drifted from the committed baselines and the
visual lane owns a deliberate, attributed re-baseline (taken after
`c2592cb0`'s dependency update, which is itself a candidate cause); this
checkpoint does not re-baseline anything. Second, one themed-shell gate
failed only after the dev server process died of V8 heap exhaustion mid-suite
and passes on a healthy server; long single-server runs on a shared
workstation need a raised heap. Third,
the reduced-settings captures the acceptance asks for did not exist, so a
focused keyboard-only gate now emulates reduced motion and reduced
transparency, asserts the opaque `--surface-alpha` backstop and the collapsed
motion duration, operates the contextual-sidebar toggle and the Library from
the keyboard, and records chat and Library captures as evidence artifacts
rather than baselines (`conventional-workspace.spec.ts`, "integrated chrome
stays keyboard-operable under reduced motion and transparency"). The
Browser-sidebar cross-view utility mount remains the amendment's declared
follow-up with the trailing toggle mount contract preserved.
