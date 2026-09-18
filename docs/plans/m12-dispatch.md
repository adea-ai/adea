# M12 dispatch plan — parallel agent coordination

- Normative companions: [M12 plan](m12-dev-view.md) (start contract, DAG, ownership) and [Dev Runtime spec](../specs/dev-runtime.md). This file adds only **how parallel implementation agents coordinate**; it changes no acceptance criteria.
- **One agent per issue.** An agent reads the M12 plan, ADR 0009, the Dev Runtime spec, its issue, and its manifest slice; then works only inside its **owned paths** (below).
- Branch naming: `feat/m12-<issue>-<slug>` (substrate: `feat/m10-<issue>-<slug>`, `feat/m11-<issue>-<slug>`). PRs: draft → ready after local validation → squash merge; required checks `Validation / Gate` + `Desktop shell`.

## File-ownership map (concurrent agents never edit another agent's paths)

| Agent | Issue | Owned paths (exclusive while open) |
| --- | --- | --- |
| S1 | #395 shell/panes | `packages/dev-view/src/**` (except editor/browser/files/source-control/sidebar-registry dirs owned later), `packages/workspace-ui/src/global-workspace-rail.tsx`, `apps/web/src/components/workspace-navigation.tsx`, dev-view CSS additions |
| S2 | #425 appearance/App Library | `packages/ui/src/components/theme-provider.tsx`, `packages/ui/src/styles/theme.css`, `packages/workspace-ui/src/plugins-dialog.tsx` + plugins catalog modules, appearance popover components. **Holds `global-workspace-rail.tsx` / `workspace-navigation.tsx` until S1's Dev-entry merge lands** |
| M1 | M10 #33 boundary/channel auth | `apps/desktop/shell/src/commands.ts`, shell auth/channel modules, `packages/types/src/dev-runtime.ts` auth/channel DTO blocks |
| M2 | M10 #34 grants/roots/vault | shell grant/vault/root-bookmark modules (disjoint files from M1), `packages/types/src/dev-runtime.ts` grant DTO blocks |
| M3 | M10 #185 local stack supervision | shell supervision/component-manifest modules |
| CP1 | control-plane#548 (CP repo) | `apps/local-control-plane/**`, `packages/sqlite-persistence/**` |

Shared files — append/coordinate, never rewrite: `docs/research/dev-view-source-manifest.json` (own issue's slice block only), `docs/research/dev-view-donor-audit.md` + root `NOTICE` (own issue-tagged rows only, per the plan's ownership protocol), `packages/types/src/dev-runtime.ts` (additive DTO blocks only, per issue-tagged section). Merge order = wave order when these conflict.

## Waves

**Wave A — dispatch immediately (independent):**

| Agent | Issue | Gate to close |
| --- | --- | --- |
| S1 | #395 shell/panes | #394 (done) |
| S2 | #425 appearance/App Library | #394 + S1's rail-entry merge |
| M1 | M10 #33 boundary/channel auth | standalone substrate |
| M2 | M10 #34 grants/roots/vault | coordinates with M1 |
| M3 | M10 #185 local stack supervision | CP#548 contracts (parallel) |
| CP1 | control-plane#548 SQLite durable queue + profile conformance | standalone (CP repo, CP-M11) |

**Wave B — dispatch when #395 and M10 #33/#34/#185 have merged** (fixture work may start earlier; closure per plan):

| Agent | Issue | Extra closure deps |
| --- | --- | --- |
| T1 | #396 terminal | #397 + M10 #30–#32 |
| T2 | #397 worktrees | M10 authorities only |
| T3 | #399 files/local source control | M10 #33 |
| T4 | #422 browser/devices | M10 #33/#34/#185; closes before #400 is allowed to (agent-event attachment waits) |
| T5 | #471 permissions page | M10 #33 capability reporting |
| M4/M5/M6 | M10 #30 discovery, #31 managed Pi, #32 ACP | standalone substrate |

**Wave C — dispatched from Wave B merges:** #398 (needs #397), #400 (needs #396 + M11 #36–#41/#43 — **M11 contracts are Wave B-parallel work in their own issues**), #423 (needs #398/#399), #424 (needs #396/#397/#398/#400/#422 — fixtures may start earlier), #472 computer use (planning-first slice after #400/#422/#471). Then #426 integration/release gate last.

## Rules for every agent

1. The plan's start contract applies verbatim: no design re-discovery, no questions the package answers; blockers are recorded on the issue and the agent moves to another dependency-ready slice.
2. No harness engineering (owner directive): orchestration selects; harnesses execute. Decision-layer behavior belongs to control-plane#558, not to Dev View code.
3. Spec/ADR/manifest/NOTICE changes land in the same commit as the behavior that requires them (per-plan ownership protocol).
4. Do not edit another open agent's owned paths. If a shared file must change in a way ownership forbids, stop that file and note it in the PR — the wave owner resolves.
5. Every PR records its Bun runtime-version guards (adea#490) and Bun-native adoption items where its slice owns them (#33/#396/#397/#398/#399/#422/#426).
6. Prohibited-donor rules are absolute: no Warp AGPL material, no `hexuria/opengrok` anything.
