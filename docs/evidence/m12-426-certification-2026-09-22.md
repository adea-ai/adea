# M12 #426/#541 release-gate certification package — 2026-09-22

Assembled evidence package for the #426 release gate and its remainder issue
#541 ("release-gate certification package"). For every #426 completion box this
record states one of: **met** (with an evidence pointer), **partial** (evidence
exists; the named remainder is tracked), or **open** (tracked in an issue). It
is a certification package, not a closure claim — "what remains for full
closure" is the last section.

Produced on `feat/m12-426-cert` (worktree of main @ `f31adea7`, v0.45.1 + the
#472 real-OS acceptance + the #424 scale lane), macOS ARM64, 2026-09-22.

## Evidence package index

- Packaged stable-app owner-journey lane evidence:
  `docs/evidence/m12-426-owner-journey-packaged-2026-09-22.md`
  (machine artifact `artifacts/packaged/owner-journey-stable-2026-09-22.json`)
- WCAG 2.2 AA automated audit: `docs/evidence/m12-426-a11y-2026-09-22.md`
  (machine artifact `artifacts/a11y/axe-dev-view-2026-09-22.json`; audit lane
  `scripts/audit-a11y-dev-view.mjs`; findings filed as #598, #599, #600, #601)
- Scale/bounded-storage budgets: `docs/evidence/m12-424-scale-2026-09-22.md`
- Real-OS computer-use acceptance: `docs/evidence/m12-472-computeruse-packaged-2026-09-22.md`
- Packaged lifecycle and terminal lanes: `docs/evidence/m12-396-397-packaged-2026-09-22.md`,
  `docs/evidence/m12-397-packaged-lifecycle-2026-09-22.md`
- Packaged native boundary and vault: `docs/evidence/m10-33-packaged-native-2026-09-22.md`,
  `docs/evidence/m10-33-packaged-vault-2026-09-22.md`
- Fresh security-lane run for this package: `bun run test:security:dev-runtime`
  passed 2026-09-22 (5 suites, summary `artifacts/dev-runtime/security-summary.json`)

## #426 completion criteria, box by box

1. **Owner journey passes against a packaged build with recorded
   screenshots/video evidence and no manual database/file repair — partial;
   remainder owned by #541.**
   The packaged owner-journey lane ran against a freshly built stable app
   (release-lane build sequence, `electrobun build --env=stable`; identity
   0.1.0/stable): project import through owner-approval verification, isolated
   worktree creation, runtime session creation, generation-fenced
   archive/unarchive with lossless restore, and disposable cleanup all pass
   with `manualRepair: "none"`. The browser/device leg and screenshot/video
   recording are typed `blocked`, honestly, because no packaged CEF/CDP engine
   publishes frames (#537). Evidence: the owner-journey doc in this package.

2. **Every upstream M12 acceptance checkbox verified or linked to a separately
   accepted follow-up; no silent deferral — partial; re-verification owned by
   #541.** The criteria audit produced #541 (and #538 for the terminal
   endurance remainder); this package adds the 2026-09-22 evidence passes
   above. Final re-verification at closure is #541's own gate.

3. **Local and remote paths share contracts/UI and enforce node/workspace
   authority; M12 has fake-node/revocation/scope-isolation evidence and M14
   owns production remote certification — met (with the M14 carve-out the box
   itself states).** Shared Dev Runtime contracts and the runtime-node
   authority model are specified (`docs/specs/dev-runtime.md`,
   `docs/specs/runtime-nodes.md`) and enforced by suites in the tree
   (`packages/db/tests/integration/runtime-nodes.test.ts` — pairing, signing
   vs command keys, one-time challenges, rotation, revocation;
   `apps/desktop/tests/dev-runtime-command-matrix.test.ts` and the scope/
   authority suites in the security lane). Production remote certification is
   explicitly M14/#475.

4. **Security/adversarial suite passes; packaged-app tests prove loopback
   clients, browsed embedded pages, stale channels and replay tokens cannot
   invoke privileged commands without M10 authorization; no high/critical
   finding remains — partial; remainder #541.** The named security lane
   (`bun run test:security:dev-runtime` — command matrix, shell channel,
   browser lanes, vault, terminal input authority incl. generation fences)
   passed on 2026-09-22 for this package. Packaged boundary proofs: the M10
   #33 native/vault evidence docs and the boundary scanners pinned by
   `bun run test:security`. The "no high/critical finding remains" clause is
   checked again at #541 closure (new findings from this package are
   accessibility issues #598–#601, tracked).

5. **Accessibility audit meets WCAG 2.2 AA for the complete journey — partial;
   remainder #541.** Automated axe coverage (the accepted v1 scope) is
   recorded in this package's a11y doc: 3 violation classes (65 critical /
   38 serious node-hits), each filed — #598 (settings tabs lack a tablist
   parent), #599 (contrast in Dev row badges and Settings nav labels),
   #600 (focusable separator without value state), plus the interaction
   defect #601 (clicking the selected tab dismisses the Settings dialog).
   Manual screen-reader/keyboard certification is an open gap.

6. **Performance budgets and 24-hour soak pass with retained artifacts —
   partial.** Budgets and bounded-storage evidence: the #424 scale lane
   (100 sessions/1,000 processes, 16 ms pull budget, 720-point metrics cap,
   byte-measured retention) in `docs/evidence/m12-424-scale-2026-09-22.md`.
   Open gap: the 24-hour multi-session soak with retained artifacts (the
   bounded 20-round soak lane and the terminal endurance lane are green but
   are not a 24-hour run).

7. **Offline/reconnect/restart/update/rollback/disk-full/permission-loss and
   partial-cleanup recovery are proven — open; tracked in #541.** Existing
   pieces: packaged sidecar crash/adopt/restart lifecycle evidence
   (`m12-397-packaged-lifecycle`), reconnect/resume transport evidence in the
   terminal lanes, and the release lane's update-feed/rollback verify gates.
   No single matrix proves offline launch, update-with-active-sessions,
   rollback, disk-full, and permission loss together; that matrix is the
   remaining work.

8. **Packaged artifacts contain required runtime assets/notices and no
   prohibited donor/vendor/generated content — met (release-lane gates) with
   #541 re-verification at closure.** `release-assets.yml` verify gates assert
   the payload structure (sidecar `entry.js`, SPA `client/index.html`, CEF
   framework, `AppIcon.icns`) and the signed update feed, pinned by
   `scripts/test-suite-boundary.test.ts`; `NOTICE` and the donor denylist
   boundary scanners (e.g. `scripts/dev-view-boundary.test.ts`) run in the
   validation lanes; the stable bundle built for this package carried the
   bundled Bun, client, and sidecar (owner-journey step `packaged-bundle`).

9. **Docs/spec/router/provenance are current and all links resolve — met
   (ticked in #426).** `scripts/check-docs.mjs` / `docs-boundary.test.ts`
   guard spec routing and relative links; no change this package.

10. **Existing repository checks pass exactly; M12 adds and runs named
    smoke/eval/performance/soak lanes before closure — met (ticked in #426).**
    The named lanes exist and are pinned (`test:packaged`,
    `test:packaged:owner-journey`, `test:security:dev-runtime`,
    `test:performance:dev-runtime`, `test:soak:dev-runtime`, `test:scale`);
    this package ran the owner-journey and security lanes fresh.

11. **Final diff and release checklist show no secrets, user paths, stale
    fixtures, or unrelated changes — open until closure (#541).** This
    package's own diff follows the hygiene rules (no secrets, no absolute
    personal paths in evidence docs, artifacts stay untracked).

## Known gaps (recorded, not waived)

- **Packaged browser/CDP evidence** — no packaged CEF/CDP engine publishes
  frames (#537): browser/device journey legs, annotations, takeover, and
  screenshot/video journey recording stay blocked.
- **WCAG manual audit** — screen-reader, keyboard-only journey, zoom levels,
  reduced-motion/transparency, and multi-theme contrast certification remain
  after the automated pass (#598–#601 cover the found classes only).
- **24-hour soak** — bounded lanes are green; the 24-hour multi-session run
  with retained descriptors/listeners/memory/disk artifacts is not done.
- **Offline/update matrix** — offline launch, update with active sessions,
  sidecar version migration/drain, rollback, disk-full, and permission loss
  are not yet proven as one matrix.
- **Stable-channel signing** — the lane-built stable bundle is ad-hoc signed;
  code signing/notarization evidence comes from the release lane.

## What remains for full closure of #426/#541

1. Land the a11y fixes (#598, #599, #600) and the settings-dialog fix (#601),
   re-run `bun scripts/audit-a11y-dev-view.mjs` to zero serious/critical.
2. Deliver the packaged CEF/CDP engine (#537), then complete the browser legs
   and screenshot/video journey recording; re-run the packaged owner-journey
   lane to `passed`.
3. Run and retain the 24-hour multi-session soak artifacts.
4. Execute and record the offline/restart/update/rollback/disk-full/
   permission-loss matrix on a signed packaged build.
5. Manual assistive-technology certification over the fixed UI.
6. #541's closure pass: re-tick each box above from fresh evidence, then the
   final diff/release-hygiene review.
