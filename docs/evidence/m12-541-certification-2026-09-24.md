# M12 #426/#541 release-gate certification package — 2026-09-24

Assembled evidence package for the #426 release gate and its remainder issue
#541 ("release-gate certification package"). Every #426 completion box is stated
as **met** (with an evidence pointer), **partial** (evidence exists; the named
remainder is stated), or **open** (tracked in an issue). It is a certification
package, not a closure claim: "what remains" is the last section, and the three
figures still in flight are named rather than rounded up.

Assembled on `main` @ `79a62b2f` (v0.52.2 plus the owner-journey browser-leg fix
in #652), macOS ARM64, 2026-09-24.

## #426 completion criteria, box by box

### 1. Owner journey passes against a packaged build, with recorded evidence and no manual repair — **met for every journey leg; the browser/screenshot leg is composed and awaits its packaged run**

The packaged owner-journey lane passes against the installed stable build
(`Adea 0.1.0 (stable)`, bundled Bun + terminal sidecar present):

```
ok: packaged-bundle — Adea 0.1.0 (stable) contains the bundled Bun and terminal sidecar
ok: project-import — imported <project> with one authorized root
ok: isolated-worktree — <worktree> (ready, bootstrap=not_started)
ok: runtime-session — created <session> in preparing state
ok: archive-unarchive — archive=archived, restore=restored, records=2
ok: disposable-cleanup — temporary repository and data root removed
PACKAGED-OWNER-JOURNEY PASSED
```

The browser leg is **composed, not re-driven**: the packaged browser-matrix proof
owns the engine evidence (lane registration through the gate, admitHop-gated
navigation, screenshot publication with provenance, live screencast frames
through a real minted grant, per-hop SSRF refusal, crash → typed recovery), and
the journey lane reads its artifact and records the artifact's `sha256`
(PR #652). That replaced a `blocked` row whose blocker named #537 — an issue
that closed on 2026-09-22 — which had been reporting a nonexistent engine gap.

Remainder: the packaged lane (`bun scripts/test-dev-runtime-packaged.mjs`) must
be run on this tree for the certification artifact set, which is scheduled after
the soak completes. Until then the journey's browser rows report `blocked` for
the accurate reason (the proof has not been run in this workspace).

### 2. Every upstream M12 acceptance box verified or linked to an accepted follow-up — **met; the audit is below**

The milestone carries 25 issues: 21 closed with evidence, 4 open. The only
unticked acceptance boxes in the whole milestone are three, all gated on the soak
running today:

| Issue                                               | State  | Unticked boxes                                                                                           |
| --------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| #396 — terminal: PTY sidecar, transport, replay, UX | open   | 1 — the 24-hour soak row                                                                                 |
| #422 — browser & devices                            | closed | 0 (the 30-minute preview row was measured on 2026-09-23)                                                 |
| #426 — integration/hardening/release gate           | open   | 2 — the upstream-verification box and the budgets+soak box, both discharged by this package and the soak |
| #610 — native cookie source detection               | closed | 0 (packaged-runtime read verified; its client surface filed as #646)                                     |

Closed slices and remainders, with their closures: #394, #395, #397–#400,
#423–#425, #471, #472, #490, #537, #538, #540, #542, #543 and #610 all closed on
evidence; #539 and #541 (this package) carry the two threads each states. No box
was left ambiguous: where a clause genuinely belonged to another milestone it was
linked rather than ticked.

### 3. Accessibility audit meeting WCAG 2.2 AA across the complete journey — **partial; the manual screen-reader pass is owner-side**

The automated audit lane is in place (`scripts/audit-a11y-dev-view.mjs`,
`docs/evidence/m12-426-a11y-2026-09-22.md`), its findings were filed and fixed
(#598–#601), and Dev View surfaces carry accessible names and roles that the
Playwright lanes assert. A WCAG 2.2 AA _certification_ is not something an
automated axe pass can grant: the manual screen-reader and keyboard-only pass
across the complete journey needs a human at the machine, and it remains the
owner's. This package does not claim it.

### 4. Performance budgets and 24-hour soak with retained artifacts — **partial; soak in flight (completes 2026-09-25 ~11:59)**

Budgets, each with a retained artifact and a named lane:

| Budget                                                                                               | Lane                                                | Result                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview lane: startup, frame latency, CPU/RSS idle+active, 30-minute window, bounded capture storage | `browser-preview-perf.ts`                           | 30.2 min window; startup 4,825 ms; capture p50 251 ms; RSS 52.4→62.9 MB; 0 capture refusals (`docs/evidence/m12-422-preview-perf-2026-09-23.json`) |
| Usage surface: sampling discipline, 16 ms UI-task analog, 720-point cap                              | `test:scale:dev-runtime`                            | one `ps` per pull, ≤64 PIDs, projection/summary under budget, caps bind exactly                                                                    |
| Packaged runtime long task                                                                           | `packaged-usage-long-task.mjs`                      | projection p95 1.12 ms, summary p95 0.15 ms on the app's own Bun                                                                                   |
| Terminal endurance and bounded durable storage                                                       | `test:terminal-endurance`, the soak's storage phase | see the soak artifact                                                                                                                              |

The 24-hour soak is running on settled main since 2026-09-24 11:59 local
(`/tmp/adea-soak-24h-3.log`, parent PID in `/tmp/adea-soak-24h-3.pid`). Its first
attempt **failed**, and the failure is part of this package rather than hidden:
three accounting assertions tripped in 12,541 rounds, and reading the per-round
ledger showed the lane's own round boundary was at fault — the slow-subscriber
phase's tail-marker wait was unchecked, so under load a phase tail was charged to
the next round (duplicates plus surplus). PRs #645 and #648 fixed the boundary,
added per-failure attribution (acks issued and their round-trip, MAIN-subscriber
resyncs, notices seen), and stopped the budget guard from reporting a phantom
round cap. The current run is the acceptance attempt.

### 5. Recovery matrix — **met**

`docs/evidence/m12-426-recovery-matrix-2026-09-23.md` (PR #635): one row per
scenario — offline, reconnect, restart, update, rollback, disk-full,
permission-loss, partial cleanup — with the named pin that holds it and a bounds
section stating what each row does not cover.

### 6. Final diff and release checklist hygiene — **met**

Run against `main` @ `79a62b2f`:

| Check                                         | Result                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Secret-shaped strings in tracked files        | none (`sk-…`, `ghp_…`, `AKIA…`, `xox…`, private-key headers)                                                                               |
| Personal/machine paths in tracked files       | none containing `/Users/amf`; the remaining `/Users/<name>/` matches are synthetic test personas (`someone`, `dev`, `example`, `me`, `am`) |
| Committed build output, artifacts, env files  | 0 tracked (artifacts/ build/ .turbo/ .env)                                                                                                 |
| Docs boundary (`node scripts/check-docs.mjs`) | exit 0                                                                                                                                     |
| Formatting (`bunx oxfmt --check .`)           | clean on the full tree                                                                                                                     |
| Lint (`bunx oxlint`)                          | 0 warnings / 0 errors on every touched tree                                                                                                |

## What remains for full closure

1. The 24-hour soak's artifact (`budgetHonored: true`, 0 integrity failures) —
   then #426's budgets box and #396's soak row are ticked and both issues close.
2. The packaged lane run on this tree, for the browser/screenshot artifact set —
   then #426's owner-journey box is met outright rather than by composition.
3. The manual screen-reader/WCAG pass, which is owner-side by nature.
4. #539's two threads: the provider-billed decision is recorded (BYOK), the
   packaged long-task lane is landed; the issue closes with the soak.
5. #646 — the cookie-import client surface (capability implemented and verified;
   the UI for it is filed).

Remote production certification belongs to M14 (#475); this package is the LOCAL
gate.
