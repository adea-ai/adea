# Safe development-resource reuse and cleanup tooling (#1567)

The reported problem is repeated Docker growth beyond 100 GB and stale worktrees after a
cleanup. This records the tooling that decides what may be reused and what must be
preserved, and the dry-run eligibility report it produces. It records no 100 GB
measurement: the growth is the reported history, and the report below is the current
state of this host.

#1543 already owns the integration lane's leases and claims, and the tooling builds
on that model rather than replacing it. What #1543 does not own is stale-resource
reclamation, so the additions are the ownership-and-lease inventory, the stale-worktree
reuse decision, the dry-run eligibility report, the disk telemetry and the concurrency
bound.

## The decisions the tooling makes

A resource is reclaimable only when all three hold: the lane's own model says this run
created it, a lease of this run names it, and that lease's owner is gone. A resource
this run's label covers but no lease proves is protected, because a running container is
not a lease. An active, foreign or uncertain owner is protected, and a resource nobody
has claimed is protected: an unlabelled volume is not evidence of anything.

A stale worktree is reused only when the local work is already committed, the fetched
origin ref contains the checkout's head, the commits are published, and no live owner
holds it. Local work is never overwritten. A checkout with changes is preserved; a
checkout whose origin is behind is refused until its owner refreshes it. Every refusal
names the condition that failed.

The report gives every item a decision, a reason and the evidence behind it, and the
preservation proof shows that nothing protected was scheduled for reclamation. Disk
telemetry separates the Docker cache from the checkout sizes, because they are
reclaimed by different means. The concurrency bound refuses a run that would exceed
it rather than queueing it.

## Source heads

| What           | Head                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Base           | `d3c24c1c1960ea04692eefae9b827de0dd9e0d0d` (adea-ai/adea `main`)                                   |
| Tooling branch | `codex/f1w28-adea-1567-dev-resource-reuse`                                                         |
| Tooling commit | `fcf05c07a` — `feat(scripts): add the safe development-resource reuse and cleanup tooling (#1567)` |

Added: `scripts/dev-resource-reuse.mjs` (the model), `scripts/dev-resource-reuse.test.ts`
(the regressions), `scripts/dev-resource-reuse-report.mjs` (the dry-run report runner).

## Commands and evidence

| Check                   | Command                                                                                                                      | Result                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Focused regression      | `bun test scripts/dev-resource-reuse.test.ts`                                                                                | 25 pass, 0 fail, 53 expect() calls                |
| Repository scripts lane | `bun test scripts/*.test.ts`                                                                                                 | 1354 pass, 0 fail, 11572 expect() calls, 88 files |
| Formatting              | `bunx oxfmt --check scripts/dev-resource-reuse.mjs scripts/dev-resource-reuse.test.ts scripts/dev-resource-reuse-report.mjs` | All matched files use the correct format          |
| Lint                    | `bunx oxlint --deny-warnings` (the three files)                                                                              | 0 warnings, 0 errors                              |
| Type check              | `bun check -p tsconfig.json` (the repository gate)                                                                           | No type errors in 328 files                       |
| Pre-commit gate         | `git commit` → `.githooks/pre-commit` → `code-foundry pre-commit`                                                            | `vp run: 33/33 successful`                        |

The two type errors the root `tsconfig.json` reports for `scripts/dev-resource-reuse.test.ts`
(`TS7016`, no declaration file for a `.mjs` module) are the repository's existing pattern
for script tests: `scripts/disposable-postgres-volume-cleanup.test.ts` reports the same
error class for the same reason. The gated type check is the per-package
`vp run orch:typecheck`, which does not cover `scripts/`.

The regression suite covers the crash and restart cases and the concurrent-owner cases
the issue names: a run that died leaves a reclaimable resource, a restarted run does not
reclaim what it cannot prove it owns, an unreadable lease is uncertain, a second live
owner protects the resource and refuses the checkout, and two owners cannot both pass
the concurrency bound.

## The dry-run report on this host

```
bun scripts/dev-resource-reuse-report.mjs --repo <repo> --fetch \
  --lease-dir <lease dir> --report <path>
```

| Field                     | Value          |
| ------------------------- | -------------- |
| Docker resources seen     | 27             |
| Eligible resources        | **0**          |
| Registered checkouts seen | 38             |
| Reusable checkouts        | **0**          |
| Preserved                 | 65             |
| Preservation violations   | 0              |
| Checkout bytes reported   | 41,003,118,592 |

Nothing was eligible, and every reason is recorded. The Docker resources are protected
because this run owns no project; the checkouts are refused because they carry local
work, because the fetched origin ref does not contain their head, or because their
commits are published nowhere else. No lease record was present in the inspected
directory, so no resource was provably owned by any run.

## Boundaries

No blanket `docker system prune`, no volume or data deletion, and no secret or history
removal. The report is a permission, not an action: nothing in this tooling removes
anything, and a caller that holds the applicable permission acts on the eligible items
after reading the reasons. This record claims no live acceptance, no native acceptance
and no production readiness.
