# M12 #541 — manual keyboard + screen-reader-semantics certification (2026-10-06)

The #541 release gate recorded the manual keyboard/AT certification as its
accepted v1 gap ("needs a human at the machine"). This pass closes the
certification with an automated keyboard + programmatic-assistive-technology
method, fixes every violation it found, and states the residuals honestly.

## Method disclosure

What was exercised, and by what driver — this certification is **keyboard-only
operation plus programmatic AT semantics**, not a hand-driven screen-reader
session:

- **Driver**: Playwright/Chromium (the apps/web E2E harness), Dev View in the
  deterministic `devE2e=preserved` fixture mode, compose Postgres, web dev
  server, macOS arm64, repository state `feat/a11y-keyboard-sr-cert`
  (= `origin/main` @ `3c04184fb` + this fix set; rebased after #1053 removed
  `dev.project.reorder` and the group sections, so `cert 4.1.3` certifies the
  shipped workspace-rail reorder surface instead of the removed sidebar one).
- **Keyboard walkthrough**: per surface, focus was moved exclusively by
  keyboard (Tab/Shift+Tab, arrows, Enter/Space, Escape, the app's own
  chords). Each walk asserts reachability, operability, focus visibility,
  logical order, and absence of traps — see
  `apps/web/e2e/dev-view-a11y-certification.spec.ts` (12 tests, all passing).
- **Programmatic AT semantics**: per-surface ARIA snapshots (role, name,
  state — `toMatchAriaSnapshot`), live-region announcements for async
  outcomes (WCAG 4.1.3), and the accessible-name/role/value checks that a
  screen reader consumes. The axe-core strict re-scan runs over the whole
  journey matrix (`scripts/audit-a11y-dev-view.mjs --strict`).
- **Not exercised (residuals below)**: a human-operated VoiceOver/NVDA/Orca
  pass (rotor ergonomics, verbosity tuning, braille table output), and the
  packaged-CEF browser surface (tracked on #422/#426, engine-gated).

Surfaces covered: workspace frame (top bar, global rail, skip link), the
projects/sessions sidebar (disclosure rows, archive shelf, add-project
form), terminal pane (fixture stream — the production keyboard contract —
including search open/close and compose), settings dialog (tab pattern, all
sections), Help Center, About, keyboard reorder announcements, the right
utility rail, splitter/pane regions, and the source-control/add-project forms.

## WCAG 2.2 AA criterion table

| Criterion                    | Result                 | Proof                                                                                                                                                                                             |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.3.1 Info and relationships | PASS                   | `cert semantics: surfaces expose structured aria snapshots` (nav/heading/button structure, `aria-current` asserted separately); `cert 1.3.1/2.1.1: splitter geometry…` (separator roles + values) |
| 1.4.3 Contrast               | PASS (carried)         | `docs/evidence/m12-426-a11y-2026-09-22.md` + the 0-serious contrast re-scan recorded there; this pass re-ran axe with contrast rules enabled — 0 findings                                         |
| 2.1.1 Keyboard               | PASS                   | `cert terminal: the fixture pane keeps the production keyboard contract` (search open/close/Escape, compose); `cert 1.3.1/2.1.1` (splitter resize + pane move chord `Ctrl/⌘+Alt+Arrow`)           |
| 2.1.2 No keyboard trap       | PASS                   | `cert 2.1.2/3.2.1` (30-stop walk never cycles); `cert dialogs` (modal trap releases on Escape, focus restores)                                                                                    |
| 2.4.1 Bypass blocks          | PASS (fixed)           | skip link hoisted to the frame's first tabbable element — was behind ~21 repeated controls; `cert 2.4.1/2.4.3` walks both the dev and chat views                                                  |
| 2.4.3 Focus order            | PASS (fixed)           | focus restoration repaired for Help Center, Settings, and About (findings 2–3); `cert dialogs` asserts restore to the opener on Escape for all three                                              |
| 2.4.4 Link purpose           | PASS                   | the bypass link and all navigation controls carry programmatic names (aria snapshots); `describeActiveElement` walk asserts nonempty names at every stop                                          |
| 2.4.6 Headings and labels    | PASS                   | aria snapshots expose heading levels per sidebar section and labelled controls                                                                                                                    |
| 2.4.7 Focus visible          | PASS                   | `cert 2.4.7` asserts `:focus-visible` + a drawn indicator at every stop of the toolbar/sidebar walk (shared primitives draw the ring; the walk proves no stop loses it)                           |
| 2.5.3 Label in name          | PASS (by construction) | icon actions are `ActionButton` with tooltip + accessible name per the lint-enforced design-system rules; the naming walk found no label-in-name mismatch                                         |
| 2.5.8 Target size            | PASS (fixed)           | findings 4a–4d below; `cert 2.5.8` (two tests) pins rows, strips, shelf toggle, topbar toggle ≥24px, and the no-overlap contract                                                                  |
| 3.2.1 On focus               | PASS                   | `cert 2.1.2/3.2.1` (URL unchanged across the walk; the workspace summary's `scene=` mirror is a data-arrival effect — recorded below, not a focus behavior)                                       |
| 3.3.1 Error identification   | PASS                   | `cert 3.3.1/3.3.2` (add-project form announces the refusal in the live region)                                                                                                                    |
| 3.3.2 Labels or instructions | PASS                   | same test: labelled controls, required inputs announced                                                                                                                                           |
| 4.1.2 Name, role, value      | PASS (fixed)           | finding 5 (session-row name tokens); snapshots assert `[expanded]`/`aria-current`/names across surfaces                                                                                           |
| 4.1.3 Status messages        | PASS                   | `cert 4.1.3` (workspace-rail keyboard reorder lands in the polite live region with position and focus); `cert 3.3.1/3.3.2` (import result announced)                                              |

## Findings → fixes (all fixed in this change set, each with a regression test)

1. **2.4.1 — the bypass link was unreachable in practice.** Both per-view skip
   links sat behind the repeated top bar, rail, and sidebar controls. Fix:
   one frame-level `workspace-skip-link` as the frame's first tabbable
   element, targeting `#dev-center` / `#workspace-main` per view; the stale
   per-view links removed. Test: `cert 2.4.1/2.4.3`.
2. **2.4.3 — Help Center dropped focus to `<body>` on close.** The panel
   mounts through a conditional `Show` (no `DialogTrigger`), so the shared
   dialog's restoration had no opener. Fix: record the opener
   (`restoreFocusRef`) and restore on close. Test: `cert dialogs`.
3. **2.4.3 — Settings and About dropped focus to `<body>` on close.** The
   account menu opened both dialogs via `onSelect`, racing the menu's own
   close-focus cycle: the dialog captured a soon-unmounted menu item, and the
   closing overlay competed with the dialog's focus restore. Fix: both items
   ride the menu's existing `onSelectAfterClose(trigger)` handover (the
   mechanism updates/feedback/help already use), and the overlays accept a
   `restoreFocusRef` to the recorded trigger; chord/hash paths keep the
   capture fallback. Probe evidence: focus after close was `BODY` before the
   fix, the trigger after it. Test: `cert dialogs`.
4. **2.5.8 — target-size violations** (axe strict, `dev-view-narrow-320`):
   - (a) sidebar disclosure rows measured ~16px (padding lived on the
     wrapper) — the button now stretches across that padding;
   - (b) drag strips' published 12px `::after` — widened to 24px on the drag
     axis, visible 1px line unchanged;
   - (c) the archive shelf's ghost disclosure and the topbar icon-sm context
     toggle — repo hooks lift both to the 24px minimum;
   - (d) **the narrow topbar painted the view-action group over the context
     toggle's edge** (axe `partiallyObscured`: 20.9×28 usable) — the groups
     no longer shrink below their content; the nav scroller owns overflow.
     Tests: `cert 2.5.8` (both tests, including the hit-probe no-overlap pin).
5. **4.1.2 — session rows announced mushed names** ("activeDev View
   foundationharness…"). Fix: explicit whitespace tokens separate the status
   chip, title, and badges. Test: `cert 4.1.2` pins the exact name.
6. **Terminal fixture vs production contract drift.** The fixture pane's
   search input did not return focus to the terminal surface on Escape, so
   the certified contract differed from the production one. Fix: the fixture
   matches the production search contract. Test: `cert terminal`.

## Recorded observations (evaluated, not violations)

- **Layered Escape.** Inside the settings dialog with a focus-triggered
  tooltip open, the first Escape closes the tooltip (topmost Kobalte layer,
  focus unmoved) and the second closes the dialog — the ARIA APG tooltip and
  dialog patterns compose this way; no trap exists and focus never moves.
  The cert test documents and pins the layered behavior deterministically.
- **Scene URL mirror.** The workspace summary's `scene=` parameter is written
  by a data-arrival effect, not on focus; the 3.2.1 walk waits for it before
  recording its baseline.

## Automated re-scan

`bun scripts/audit-a11y-dev-view.mjs --strict --artifact artifacts/a11y/axe-dev-view.json`
over the journey matrix (wide, terminal, narrow-320, settings sections,
narrow-320 archive shelf): **0 critical / 0 serious / 0 moderate / 0 minor**.
The lane also gained an animation-settle wait so it never measures a control
mid-transition.

## Pre-existing defect discovered (out of this change's scope)

`dev-view-terminal-pane.spec.ts › canonical palette changes preserve terminal
output…` fails on **current `main`** independent of this work: after a
canonical-palette change the `.xterm-viewport` background stays `rgb(0, 0, 0)`
instead of the palette's `rgb(241, 245, 249)`. Reproduced on a clean checkout
of `bd800c8e` and on `origin/main` @ `10a81910f` with this branch's changes
reverted. Filed separately; the keyboard/semantics certification is
unaffected.

## Residuals (accepted, stated rather than implied)

- A **human** screen-reader pass — VoiceOver rotor/verbosity ergonomics,
  braille display rendering, and audio-comfort judgments — remains owner-side
  by nature; this certification substitutes programmatic AT semantics for it
  and does not claim otherwise.
- The packaged-CEF browser surface keeps its typed-unavailable certification
  row (engine gap, #422/#426).
- Real-PTY terminal announcement behavior under production load (deluge
  politeness of `role="log"` output) is exercised by the soak lane's stream
  probes, not by a human AT pass.

## Environment

- Repository: `adea-ai/adea`, branch `feat/a11y-keyboard-sr-cert` = `origin/main`
  @ `3c04184fb` + this fix set; macOS arm64 (darwin 25.6.0), Bun 1.4.0,
  Playwright/Chromium headless, Vite dev server, compose Postgres.
- Validation: the 12-test certification spec green (re-run on this rebased
  head); strict axe re-scan `0/0/0/0` on the same head; workspace-ui (117) and
  web (213) unit suites green; typecheck/lint/format clean. The wider E2E
  suite (`dev-view`, `dev-add-project`, `sidebar-resize`, `dev-files-window`,
  `dev-view-terminal-pane` minus the pre-existing palette case above,
  `workspace-form`) runs in this PR's validation lanes.
