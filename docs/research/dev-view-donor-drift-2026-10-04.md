# Dev View donor-mapping drift report (2026-10-04)

- Status: audit evidence for the 2026-10-04 donor-drift sweep
- Scope: [source manifest](./dev-view-source-manifest.json),
  [donor audit ledger](./dev-view-donor-audit.md),
  [UI traceability inventory](./dev-view-ui-traceability.json),
  [implementation guide](../guides/dev-view-implementation.md),
  [Dev Runtime spec](../specs/dev-runtime.md), [updater spec](../specs/updater.md)
- Method: every manifest destination and ledger destination was checked against
  the tree at `205cc1d34`; every donor repository under `~/Developer/ADEs` was
  inspected read-only at the pinned revisions; every concrete code path named by
  the Dev Runtime and updater specs was resolved.

The four files a parallel PR is already rewriting — the source manifest, the
implementation guide, the Dev Runtime spec, and the updater spec — were **not
modified**. The exact changes they still need are listed in
[Reserved-file changes to apply](#reserved-file-changes-to-apply) so they can
land after that PR merges.

## Donor-side verification (sound)

All ten pinned donor revisions remain retrievable in the local read-only
checkouts, and every sampled manifest source/test file exists at its pin:

| Donor    | Pinned revision | Retrievable                                        | Local HEAD vs pin |
| -------- | --------------- | -------------------------------------------------- | ----------------- |
| KiroCrew | `283e136c`      | yes                                                | at pin            |
| orca     | `403b62a8`      | yes                                                | moved ahead       |
| t3code   | `77bca8b2`      | yes                                                | moved ahead       |
| terax-ai | `b02a7dcb`      | yes                                                | moved ahead       |
| bb       | `52a92563`      | yes                                                | moved ahead       |
| zeron    | `30a9a953`      | yes                                                | moved ahead       |
| muxy     | `5c5be869`      | yes                                                | moved ahead       |
| buzz     | `eed74bde`      | yes                                                | moved ahead       |
| warp     | `3959ea72`      | yes (prohibited; not retrieved for implementation) | moved ahead       |
| opengrok | `2bf49b3c`      | yes (prohibited)                                   | at pin            |

Donor HEADs having moved past the pins is expected: the pins are the contract,
not floating defaults. No donor repository was modified.

## Adea-side drift (confirmed, with evidence)

1. **#398 sidebar row destinations never landed under their planned names.**
   The manifest and traceability inventory name
   `packages/dev-view/src/sidebar/project-tree.tsx`, `project-row.tsx`, and
   `worktree-row.tsx`; git history shows no commit ever contained those files,
   and the traceability inventory itself records `matchedFiles: 0` for each.
   The project/worktree row composition actually lives inline in
   `packages/dev-view/src/sidebar/dev-sidebar-shell.tsx`
   (`DevSidebarNavigation`) plus `sidebar/repo-registry-model.ts` and
   `sidebar/repo-registry-panel.tsx`.
2. **#400 session destinations landed under different names.** The manifest
   names `apps/desktop/shell/src/dev-runtime/sessions/**` (zero matches, never
   existed). The durable `RuntimeSession` store is
   `apps/desktop/shell/src/dev-runtime/project-session/register.ts`; run
   history is `dev-runtime/harness/runs.ts`; the UI side is
   `packages/dev-view/src/{agents,history}/**`.
3. **#423 GitHub UI destination landed elsewhere.** The manifest names
   `packages/dev-view/src/github/**` (zero matches, never existed). The
   PR/checks/work-item UI is `packages/dev-view/src/source-control-app/**`
   (#1003). The host side `apps/desktop/shell/src/dev-runtime/github/**` is
   correct as mapped.
4. **#425 ledger row destinations were renamed after acceptance.**
   `packages/dev-view/src/appearance/appearance-dialog.tsx` became
   `appearance-surface.tsx` (exports `AppearancePanel`/`AppearanceControl`) in
   #659 (commit `4aea03eb7`), and `packages/ui/src/components/theme-preview.tsx`
   was deleted in #760 (commit `5162c7db5`), with the Zeron-derived preview
   composition now shipping in the published `@adea-ai/ui`
   `appearance-editor` composite. Recorded as an append-only drift note in the
   [donor audit](./dev-view-donor-audit.md); provenance, pins, and NOTICE
   obligations are unchanged.
5. **The implementation guide pins a stale dependency claim.** It states Adea
   "currently consumes `@adea-ai/ui` 0.89.1, which does not include" the shared
   Tree exports pending UI PR #179. Adea consumes 0.110.0, which publishes
   `components/composites/tree` (imported by
   `packages/dev-view/src/files/files-pane.tsx`), `catalog-browser`,
   `appearance-editor`, and the conversation paste-token / atomic-composer /
   transcript-composition entries. Reserved-file change; see below.
6. **The traceability inventory's `manifestDigest` predates the manifest.** The
   recorded digest `9636a630…` does not hash the current manifest file
   (`5c2b0503…`), and #532 chat units are not inventoried. The inventory is
   explicitly an in-progress snapshot, so this is freshness drift, not
   falsehood — recompute the digest and add the #532 units the next time the
   inventory is regenerated. Hand-editing the digest without regenerating the
   snapshot would misrepresent it.
7. **Two test comments named the pre-rename file.**
   `packages/dev-view/tests/appearance-cancel-reopen.test.ts` referenced
   `appearance-dialog.tsx`; fixed in this PR (comments only, no behavior).

## Composition gaps

No gap requiring code was found. Every mapped donor technique checked has a
current counterpart: bb/Muxy split operations (`packages/dev-view/src/layout/`,
attributed headers, consuming the published `split-layout` model), KiroCrew
history frontier (`apps/web/src/lib/workspace-history.ts`), t3code PTY adapter
shape (`dev-runtime/terminal/pty-adapter.ts`), bb terminal manager/transport
(`terminal/terminal-manager.ts`, `packages/dev-view/src/terminal/transport.ts`),
Orca checkpoints/shell integration (`terminal/checkpoints.ts`,
`terminal/shell-integration.ts`), Buzz credit/env-fence concepts
(`terminal/blocks.ts`, `shell-integration.ts`), t3code CheckpointStore/GitVcs
(`dev-runtime/git/register.ts` namespaced `refs/adea/checkpoints/**`),
Orca GitHub client (`dev-runtime/github/**`), t3code port scanner
(`browser/port-inventory.ts`), usage/appearance/permissions/computer-use/chat
surfaces (`usage/**`, `appearance/**`, `permissions/**`, `computeruse/**`,
`chat/**` consuming the published paste-token/atomic/transcript entries). The
#532 manifest statement that the host "has no structured assistant/tool event
producer" was re-verified against `dev-runtime-wire.ts` (payload still
`unknown`, no production emitters) and
[evidence/donor-ui-runtime-event-boundary.md](../evidence/donor-ui-runtime-event-boundary.md)
remains accurate.

## Reserved-file changes to apply

Apply after the parallel rewrite PR lands, rebasing onto its wording:

1. `docs/research/dev-view-source-manifest.json`
   - Slice `398`: replace the three `sidebar/project-*.tsx` + `worktree-row.tsx`
     destinations with `sidebar/dev-sidebar-shell.tsx` and
     `sidebar/repo-registry-{model,panel}.tsx` (or annotate that the rows
     compose inside the shell), keeping the donor units unchanged.
   - Slice `400`: rename destination `dev-runtime/sessions/**` to
     `dev-runtime/project-session/**` plus `dev-runtime/harness/runs.ts`.
   - Slice `423`: rename destination `packages/dev-view/src/github/**` to
     `packages/dev-view/src/source-control-app/**`.
   - Slice `426`: the `apps/desktop/**dev-view**` glob matches nothing;
     the packaged Dev View tests are `apps/desktop/tests/dev-*.test.ts` /
     `worktree-*.test.ts` etc., e2e lives under `apps/web/e2e/dev-view-*.spec.ts`.
2. `docs/guides/dev-view-implementation.md`
   - Lines ~372–378: replace the "Tree exports pending UI PR #179 / 0.89.1"
     paragraph with the current fact: the Tree/TreeRow/VirtualWindow
     composition is published in `@adea-ai/ui` (`components/composites/tree`,
     `components/layout/virtual-window`) and consumed by `files-pane.tsx`
     since 0.110.0; the remaining pending gate is the mounted-route
     browser/axe and bundle-budget acceptance, not publication.
   - #398 step 2: point the row-hierarchy adaptation at
     `sidebar/dev-sidebar-shell.tsx` + `repo-registry-*` instead of the never-
     created row files.
   - #423: note the landed UI destination is `source-control-app/**`.
3. `docs/specs/dev-runtime.md`
   - No path-level drift found: every concrete path the spec names resolves.
     Only confirm, after the rewrite, that it still references
     `source-control-app/**` (it does at `205cc1d34`) and does not reintroduce
     the pre-rename appearance/session paths.
4. `docs/specs/updater.md`
   - No drift found: every referenced script, test, and workflow
     (`release-assets.yml`, `sign-desktop-update.mjs`, boundary tests) exists.
     Nothing to change beyond what the parallel PR already does.

## Acceptance evidence (web lane, 2026-10-04)

Run against this worktree's dev server (isolated port 3101 with
`--strictPort`; the mission's port 3100 was occupied by a parallel worktree's
server, which the strict-port discipline exists to avoid — same isolation, one
port over). All commands ran from the worktree root.

- Route coverage: `/` (workspace shell, "Opening workspace…" then mounted),
  `/?view=dev&devE2e=preserved` (full Dev workspace: projects/sessions
  sidebar, Files/Source Control, Terminal, utilities), `/auth/sign-in`,
  `/auth/desktop/complete` (graceful expired-link alert). All HTTP 200,
  zero console errors on each route. No in-app dead links: the only routes are
  the four above (`apps/web/src/start/routes/**`); view switching
  (Virtual/Chat/Dev) is query-state, exercised below.
- Accessibility spot-checks (Dev workspace): every visible `button`/link has a
  non-empty accessible name (0 unnamed); all 9 `aria-expanded` disclosure
  buttons are named; keyboard Tab walks 25/25 distinct named stops
  (Back/Forward, sidebar collapses, Split pane, Close/Reopen pane, Runtime
  resources, view toggles) with no focus loss; view toggle reachable and
  announced by name ("Chat view"). Focus order is DOM-logical
  (topbar → sidebar → utilities).
- Theme checks: `appearance` record drives light (`data-appearance-mode=light`,
  no `dark` class, white surface) and dark (`dark` class, `rgb(17 16 19)`
  surface, `data-theme=adea-dark`); a custom `#ff5a00` accent applies the
  inline `--primary` role override with `data-accent=custom` and is fully
  cleared when returning to `theme`. Screenshots verified visually
  (`/tmp/adea-acceptance-dev-{light,dark,dark-accent}.png`): sane layout,
  readable contrast, accent recolors only interactive roles.
- Raw-palette scan: zero color literals in private stylesheets
  (`apps/web/src`, `packages/workspace-ui/src`, `packages/dev-view/src`,
  regex hits are `#NNN` issue references in comments); the palette authority
  remains the published canonical themes sheet
  (`packages/ui/src/styles/canonical-themes.css`).
- Desktop shell: pending. The packaged Electron/Electrobun shell was not
  launched in this pass; the desktop acceptance pointers remain those in the
  Dev Runtime spec's release matrix (packaged CEF, sidecar, TCC identity) and
  `docs/evidence/m12-*packaged-*.md`. Web-lane evidence above covers the
  shared Dev View components the shell embeds.
