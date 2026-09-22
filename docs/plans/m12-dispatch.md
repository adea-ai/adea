# M12 dispatch plan — parallel agent coordination

- Normative companions: [M12 plan](m12-dev-view.md) (start contract, DAG, ownership) and [Dev Runtime spec](../specs/dev-runtime.md). This file adds only **how parallel implementation agents coordinate**; it changes no acceptance criteria.
- **One agent per issue.** An agent reads the M12 plan, ADR 0009, the Dev Runtime spec, its issue, and its manifest slice; then works only inside its **owned paths** (below).
- Branch naming: `feat/m12-<issue>-<slug>` (substrate: `feat/m10-<issue>-<slug>`, `feat/m11-<issue>-<slug>`). PRs: draft → ready after local validation → squash merge; required checks `Validation / Gate` + `Desktop shell`.

## File-ownership map (concurrent agents never edit another agent's paths)

| Agent | Issue                            | Owned paths (exclusive while open)                                                                                                                                                                                                                                                                |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | #395 shell/panes                 | `packages/dev-view/src/**` (except editor/browser/files/source-control/sidebar-registry dirs owned later), `packages/workspace-ui/src/global-workspace-rail.tsx`, `apps/web/src/components/workspace-navigation.tsx`, dev-view CSS additions                                                      |
| S2    | #425 appearance/App Library      | `packages/ui/src/components/theme-provider.tsx`, `packages/ui/src/styles/theme.css`, `packages/workspace-ui/src/plugins-dialog.tsx` + plugins catalog modules, appearance popover components. **Holds `global-workspace-rail.tsx` / `workspace-navigation.tsx` until S1's Dev-entry merge lands** |
| M1    | M10 #33 boundary/channel auth    | `apps/desktop/shell/src/commands.ts`, shell auth/channel modules, `packages/types/src/dev-runtime.ts` auth/channel DTO blocks                                                                                                                                                                     |
| M2    | M10 #34 grants/roots/vault       | shell grant/vault/root-bookmark modules (disjoint files from M1), `packages/types/src/dev-runtime.ts` grant DTO blocks                                                                                                                                                                            |
| M3    | M10 #185 local stack supervision | shell supervision/component-manifest modules                                                                                                                                                                                                                                                      |
| CP1   | control-plane#548 (CP repo)      | `apps/local-control-plane/**`, `packages/sqlite-persistence/**`                                                                                                                                                                                                                                   |

Shared files — append/coordinate, never rewrite: `docs/research/dev-view-source-manifest.json` (own issue's slice block only), `docs/research/dev-view-donor-audit.md` + root `NOTICE` (own issue-tagged rows only, per the plan's ownership protocol), `packages/types/src/dev-runtime.ts` (additive DTO blocks only, per issue-tagged section). Merge order = wave order when these conflict.

## Waves

**Wave A — dispatch immediately (independent):**

| Agent | Issue                                                        | Gate to close                |
| ----- | ------------------------------------------------------------ | ---------------------------- |
| S1    | #395 shell/panes                                             | #394 (done)                  |
| S2    | #425 appearance/App Library                                  | #394 + S1's rail-entry merge |
| M1    | M10 #33 boundary/channel auth                                | standalone substrate         |
| M2    | M10 #34 grants/roots/vault                                   | coordinates with M1          |
| M3    | M10 #185 local stack supervision                             | CP#548 contracts (parallel)  |
| CP1   | control-plane#548 SQLite durable queue + profile conformance | standalone (CP repo, CP-M11) |

**Wave B — dispatch when #395 and M10 #33/#34/#185 have merged** (fixture work may start earlier; closure per plan):

| Agent    | Issue                                      | Extra closure deps                                                                |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| T1       | #396 terminal                              | #397 + M10 #30–#32                                                                |
| T2       | #397 worktrees                             | M10 authorities only                                                              |
| T3       | #399 files/local source control            | M10 #33                                                                           |
| T4       | #422 browser/devices                       | M10 #33/#34/#185; closes before #400 is allowed to (agent-event attachment waits) |
| T5       | #471 permissions page                      | M10 #33 capability reporting                                                      |
| M4/M5/M6 | M10 #30 discovery, #31 managed Pi, #32 ACP | standalone substrate                                                              |

**Wave C — dispatched from Wave B merges:** #398 (needs #397), #400 (needs #396 + M11 #36–#41/#43 — **M11 contracts are Wave B-parallel work in their own issues**), #423 (needs #398/#399), #424 (needs #396/#397/#398/#400/#422 — fixtures may start earlier), #472 computer use (planning-first slice after #400/#422/#471). Then #426 integration/release gate last.

## Rules for every agent

1. The plan's start contract applies verbatim: no design re-discovery, no questions the package answers; blockers are recorded on the issue and the agent moves to another dependency-ready slice.
2. No harness engineering (owner directive): orchestration selects; harnesses execute. Decision-layer behavior belongs to control-plane#558, not to Dev View code.
3. Spec/ADR/manifest/NOTICE changes land in the same commit as the behavior that requires them (per-plan ownership protocol).
4. Do not edit another open agent's owned paths. If a shared file must change in a way ownership forbids, stop that file and note it in the PR — the wave owner resolves.
5. Every PR records its Bun runtime-version guards (adea#490) and Bun-native adoption items where its slice owns them (#33/#396/#397/#398/#399/#422/#426).
6. Prohibited-donor rules are absolute: no Warp AGPL material, no `hexuria/opengrok` anything.
7. **Visual conformance is donor-sourced:** port the donor's UI composition (layout, widgets, previews, interaction flow) in Solid/Adea tokens — donor composition is the visual spec; owner review is not the design gate.

## Status ledger — 2026-09-19 (Wave C in flight)

Wave order so far, as a single glanceable ledger; update the last row as sessions land.

- **Wave A/B executed; audit remediation landed.** The Wave A/B audit fixes landed as `16f59b9c` (Wave A/B audit), `9e411f31` (Wave A/B remediation), and `385ded1a` (remediation boundary hardening) — the last two include the root named lanes (`test:packaged`, `test:security:dev-runtime`, `test:performance:dev-runtime`, `test:soak:dev-runtime`) and their scripts.
- **Remediation sessions merged; integration tip `55d8beb2`.** Terminal/supervision/worktree host-correctness `71c28eb7`, browser-lane per-hop SSRF policy `992ccfb9`, and the fail-closed Dev Runtime control plane and production composition `a7a14d2f` are integrated on the tip; the spec's 2026-09-19 "Spec changes" entries pin their behavior and tests.
- **#395/#396/#397/#422 reopened with re-closure checklists.** Each issue re-closes only when its checklist verifies the remediated behavior (control-plane scope-before-dispatch, observed-termination supervision, replay checkpoint bridges, worktree content-digest re-proofs, browser SSRF/cookie/identity rules) — not on the pre-merge state.
- **Wave C in flight.** Evidence lane (this file's companion): visual-lane determinism (`apps/web/e2e/helpers/visual.ts` — transitions forbidden during captures; PRs #504/#514/#516/#518 failed the visual lane on rail-icon transitions), the four named lanes wired to summary artifacts under `artifacts/dev-runtime/`, and the `\=======` spec-leftover fix. Known pre-existing failure on the tip (not the evidence lane's source): `test:bundle:dev-view` fails because the `workspace-navigation-entry` chunk now eagerly contains `BrowserLane` — the navigation entry's import chain must go lazy before #426 closes. Baseline regeneration for the visual lane is deferred to a single owner-run pass on the final merged tree (the `-darwin`/`-linux` sets currently predate the merged rail entries — Appearance palette, App Library, Dev entry — so pixel diffs against them are expected until then). Remaining Wave C sessions: #398 groups, #400 GitHub, #423 PR surfaces, #424 appearance/libraries completion, #472 computer use, then #426 integration/release gate.
- **#398 project registry ready for integration.** `feat/m12-398-project-registry` delivers the durable-register providers for `dev.group.create/update/delete` and `dev.project.import/create`, the `dev.project.scan` companion provider (fingerprint cache, fingerprint-bound cursors, partial-result diagnostics), the KiroCrew-derived bounded scanner under `apps/desktop/shell/src/dev-runtime/projects/`, strict `Project`/`Group`/`ProjectScanPage` reply decoders (plus the `<=` field-split decoder fix), and the sidebar add/scan panel with canonical session-lifecycle rendering. Baselines: no owned visual surfaces changed pixel-wise (the panel is disclosure-gated); regen at integration can skip dev-view sidebar fixtures.

## Status (2026-09-21)

Supersedes the 2026-09-19 ledger above (kept as history). Waves C–I are merged and shipped through v0.38.0 (`#526`); the tree below describes merged main @ `f3cfd4ba` (`#527`). Per-wave landings, one line each, pointing at the two integration PRs:

- **Wave C — packaged evidence and lane infra** (inside `#522` / `6fc16ecf`): the named root lanes (`test:packaged`, `test:security:dev-runtime`, `test:performance:dev-runtime`, `test:soak:dev-runtime`) wired to summary artifacts under `artifacts/dev-runtime/`, deterministic visual captures (`apps/web/e2e/helpers/visual.ts`), lucide/dev infrastructure, and the composition substrate; the 2026-09-19 ledger's eager `workspace-navigation-entry`/`BrowserLane` bundle failure was resolved in this consolidation (PR `#522` validation: dev-view bundle under budget).
- **Wave D — product slices** (inside `#522` / `6fc16ecf`): `#395` shell/panes, `#398` project registry + monorepo scan, `#399` files/CodeMirror/local source control, `#396` terminal runtime (`#518`), `#397` worktree lifecycle service (`#517`), `#422` browser/devices runtime (`#514`), `#400` harness launch, `#423` GitHub source control, `#424` resources/usage/cleanup, `#471` permissions page, `#472` computer-use planning slice, `#425` appearance completion.
- **Waves E–H — residue and hardening sessions** (consolidated in `#522`; the spec's 2026-09-20/21 "Spec changes" entries pin each): `#400` launch residues (initial prompt delivery, runtime-events proof), `#399` residues (`file-bytes-v1` bulk stream, hunk staging, quick-open), repository registry/archive-update, the packaged macOS evidence lane (proofs against the real bundled `.app` layout under `artifacts/packaged/`), and the review-driven hardening passes (fail-closed production composition, approval consumption, shell-wrapper verification, durable store modes, git argument fencing, push remote verification).
- **Wave I — four agent-delivered slices** (`#525` / `833e5988`): status-watcher construction with generation-fenced Dev View caches (`#399`/`#426`), the managed Pi install lifecycle (`#31` closed), boot reconcile + packaged sidecar adoption (`#185`/`#396` residues), and visual-lane determinism (`#426`).
- **Ship:** `a51f001f` (`#526`, v0.38.0) and `f3cfd4ba` (`#527`, terminal sidecar bundle staged and verified in the desktop asset lane).

### Remaining queue

- **`#185` (open):** the packaged acceptance run — clean-install owner journey, crash/restart content survival, optional-provider lifecycle, privileged-endpoint gating on the packaged app, version/digest visibility. Supervision engine, packaged manifest loading, and boot reconcile are merged.
- **`#396` (open):** packaged macOS run proving sidecar adoption + authority-gated pane writes, replay/resync packaged evidence, terminal pane visual baseline, 24-hour soak/perf records. Terminal runtime, retention GC, and packaged sidecar adoption are merged.
- **`#397` (open):** packaged run of create/bootstrap/merge-back/cleanup through the production registrar, include-copy escape proofs on the packaged path, worktree pane visual baseline. Lifecycle service, digest re-proofs, containment lane, and the bounded trash-sweep backlog are merged.
- **`#422` (open):** the real browser lane engine (Bun.WebView/CDP seam) proven through the SSRF admission gate on packaged macOS, host-tool device checks (simctl/adb), and pane baselines. Lanes, grants, per-hop SSRF policy, and the device-engine seam are merged.
- **`#423`/`#424`/`#472` (open):** GitHub PR surfaces, resources/cleanup completion, and computer-use native capture remain later M12 slices.
- **`#426` (open, closes last):** owner journey vs a packaged build, WCAG 2.2 AA audit, performance budgets + 24-hour soak records, docs/provenance finalization, and the full check battery — after the evidence items above.
- **M11 `#36`–`#43`:** the Control Plane integration milestone (SDK/contracts adoption, location-aware runtime and read models, durable command relay, event inbox, cancellation/resume/approval flows, profile sync, external harness listing, and the M6.9 pre-release certification) runs in its own issues; not part of the M12 Dev View queue.
