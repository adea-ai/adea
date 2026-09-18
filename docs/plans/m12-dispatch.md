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

**Wave A — COMPLETE (2026-09-18).** Landed: #501 (#395), #504 (#425 — preference model; visual composition port remains, see Active dispatch), #503 (M10 #33), #498 (M10 #34), #499 (M10 #185). Evidence posted on each issue. Exception: control-plane#548 stays on the CP timeline (not yet started).

**Active dispatch (Wave B first tranche — 5 agents, 2026-09-18):**

| Agent | Issue                                                      | Branch                     | Note                                                                                         |
| ----- | ---------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| T1    | #396 terminal (Bun PTY sidecar + channel)                  | `feat/m12-396-terminal`    | Start gate satisfied (#395 + M10 #33/#34/#185 merged); closure adds #397 + M10 #30–#32       |
| T2    | #397 worktrees                                             | `feat/m12-397-worktrees`   | Start gate satisfied; gates the most downstream slices (#398/#399/#423/#400)                 |
| T3    | #422 browser/devices                                       | `feat/m12-422-browser`     | Start gate satisfied; agent-event attachment waits for #400                                  |
| T4    | M10 #30 harness discovery + RuntimeConnection inventory    | `feat/m10-30-discovery`    | Critical path: gates #396/#400 closure                                                       |
| T5    | #425 visual conformance port (Zeron composition checklist) | `feat/m12-425-visual-port` | Closes the appearance visual gap the owner flagged; preference model from #504 is the wiring |

Micro-task (ride along with any agent between slices): stabilize the timing-flaky supervision retention test with an injected clock (#185 comment, 2026-09-18).

**Queue after this tranche:** #471 permissions page (M10 #33 landed — fully unblocked), M10 #31 managed Pi, M10 #32 ACP, M11 #36–#41/#43 contracts (own issues), then as merges land: #398 (needs #397), #399 (needs #397), #400 (needs #396 + M11), #423 (needs #398/#399), #424 (needs #396/#397/#398/#400/#422), #472 (needs #400/#422/#471, planning-first). #426 release gate last.

## Rules for every agent

1. The plan's start contract applies verbatim: no design re-discovery, no questions the package answers; blockers are recorded on the issue and the agent moves to another dependency-ready slice.
2. No harness engineering (owner directive): orchestration selects; harnesses execute. Decision-layer behavior belongs to control-plane#558, not to Dev View code.
3. Spec/ADR/manifest/NOTICE changes land in the same commit as the behavior that requires them (per-plan ownership protocol).
4. Do not edit another open agent's owned paths. If a shared file must change in a way ownership forbids, stop that file and note it in the PR — the wave owner resolves.
5. Every PR records its Bun runtime-version guards (adea#490) and Bun-native adoption items where its slice owns them (#33/#396/#397/#398/#399/#422/#426).
6. Prohibited-donor rules are absolute: no Warp AGPL material, no `hexuria/opengrok` anything.
7. **Visual conformance is donor-sourced:** port the donor's UI composition (layout, widgets, previews, interaction flow) in Solid/Adea tokens — donor composition is the visual spec; owner review is not the design gate.
