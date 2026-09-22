# M12 #397 packaged lifecycle evidence — 2026-09-22

This record extends the packaged worktree evidence from PR #560. It is a
focused re-closure artifact and does not close #397 or claim milestone
completion.

## Command and result

```text
bun apps/desktop/shell/scripts/packaged-worktree-smoke.ts \
  --app-bundle apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app \
  --artifact artifacts/packaged/worktree-containment.json
```

The run used Bun `1.4.0`, the staged DEV macOS app bundle from the packaged
lane, and completed with `PACKAGED-WORKTREE-CONTAINMENT PASS`. The JSON
artifact recorded 32 checks and 0 failures.

## New gates exercised

- A workflow-bound disposable worktree was created by the registrar-owned
  service, its approved bootstrap was retried through signed
  `dev.worktree.retryBootstrap`, and the marker was verified in the checkout.
- A committed change was merged to `refs/heads/main` through signed
  `dev.worktree.mergePlan` and `dev.worktree.mergeCommit`; the published main
  commit contained `merged-from-packaged.txt`.
- The source branch was aligned with integrated main, the startup lease was
  released, and signed `dev.worktree.cleanupPlan` and `dev.worktree.cleanupCommit`
  completed with no blockers. The checkout and Git worktree registration were
  both absent afterward.
- A `.worktreeinclude` symlink candidate pointing outside the repository was
  rejected through `dev.worktree.create` with `symlink_rejected`; the outside
  sentinel was unchanged.

The registrar plan commit handlers were corrected in this lane to bind their
resource to the stored immutable plan. Their public DTOs contain only
`planId` and `planDigest`, so checking `body.worktreeId` rejected every valid
commit before the fix.

## Boundary and remaining gates

The current `dev.worktree.create` contract carries `bootstrapWorkflowId`, but
the packaged composition root does not yet expose a workflow and owner
approval resolver. Therefore initial workflow binding in this evidence uses
the registrar-owned service injection seam; bootstrap retry, merge, cleanup,
and include-copy refusal all run through signed production registrar commands.
The resolver path still needs a packaged authority-gated owner journey before
#397 can be closed.

Headless execution did not perform the worktree pane visual baseline review,
manual native review, crash-at-each-step matrix, failed-trash-operation
recovery matrix, or the required 24-hour endurance gate.
