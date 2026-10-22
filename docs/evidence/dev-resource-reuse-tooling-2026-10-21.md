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
| Repair commit  | `7302fb4b6` — `fix(scripts): fail closed on the reuse decision the report makes (#1567)`           |

Added: `scripts/dev-resource-reuse.mjs` (the model), `scripts/dev-resource-reuse.test.ts`
(the regressions), `scripts/dev-resource-reuse-report.mjs` (the dry-run report runner),
`scripts/dev-resource-reuse-report.test.ts` (the runner-level regressions).

## Commands and evidence

| Check                   | Command                                                                                 | Result                                            |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Focused regression      | `bun test scripts/dev-resource-reuse.test.ts scripts/dev-resource-reuse-report.test.ts` | 46 pass, 0 fail, 113 expect() calls               |
| Repository scripts lane | `bun test scripts/*.test.ts`                                                            | 1375 pass, 0 fail, 11632 expect() calls, 89 files |
| Formatting              | `bunx oxfmt --check` (the four scripts and this record)                                 | All matched files use the correct format          |
| Lint                    | `bunx oxlint --deny-warnings` (the four scripts)                                        | 0 warnings, 0 errors                              |
| Type check              | `bun check -p tsconfig.json` (the repository gate)                                      | No type errors in 328 files                       |
| Pre-commit gate         | `git commit` → `.githooks/pre-commit` → `code-foundry pre-commit`                       | `vp run: 33/33 successful`                        |

The two type errors the root `tsconfig.json` reports for `scripts/dev-resource-reuse.test.ts`
(`TS7016`, no declaration file for a `.mjs` module) are the repository's existing pattern
for script tests: `scripts/disposable-postgres-volume-cleanup.test.ts` reports the same
error class for the same reason. The gated type check is the per-package
`vp run orch:typecheck`, which does not cover `scripts/`.

The regression suite covers the crash and restart cases and the concurrent-owner cases
the issue names: a run that died leaves a reclaimable resource, a restarted run does not
reclaim what it cannot prove it owns, an unreadable lease is uncertain, a second live
owner protects the resource and refuses the checkout, and two owners cannot both pass
the concurrency bound. The repair commit adds the cases the review found: a stale lease
followed by a live one, an owner that cannot be established, a shared or unknown scope,
a removable disposition without a matching lease, an eligible item that contradicts its
own evidence, an ignored artifact that is not a build output, a verified origin that
reaches the planner, and a listing whose modified entries are not read as ignored
paths.

## The dry-run report on this host

```
bun scripts/dev-resource-reuse-report.mjs --repo <repo> --fetch \
  --lease-dir <lease dir> --report <path>
```

The counts move with the host: the fleet adds and retires checkouts while it runs, so the
numbers below are one run's, and the report is the authority for any later run.

| Field                        | Value              |
| ---------------------------- | ------------------ |
| Docker resources seen        | 29                 |
| Eligible resources           | **0**              |
| Registered checkouts seen    | 16                 |
| Reusable checkouts           | **1**              |
| Preserved                    | 44                 |
| Preservation violations      | 0                  |
| Fetch requested and observed | succeeded          |
| Ownership sources read       | lease records only |

Every reason is recorded. The Docker resources are protected because this run owns no
project and no lease record was present in the inspected directory, so no resource was
provably owned by any run. The checkouts are refused because they carry local work, or
because the fetched origin ref does not contain their head, or because their commits are
published nowhere else, or because they carry an ignored artifact that is not a known
build output.

One checkout was reusable: clean, its head in the fetched origin ref, published, and no
lease naming it. That is a statement about the leases the tooling read. The shared
ownership index records a live owner for that checkout outside the lease model, so the
report does not treat it as free — the report says what it saw, and the permission
decision stays with the operator.

## Boundaries

No blanket `docker system prune`, no volume or data deletion, and no secret or history
removal. The report is evidence, not a permission and not an action: nothing in this tooling
removes anything, and the report records what the tooling found about the resources and
checkouts it could see. The permission to remove anything remains with the operator who
holds it, and it is applied to the eligible items only after every reason has been read.

The report also states what it could not see. Its ownership comes from the lease records
alone, so a checkout held by a session or a task outside the lease model is invisible to
it. An eligible checkout is therefore a statement about the resources and leases the
tooling read; it is not a clearance to remove a checkout that another owner holds.
Symmetrically, zero eligible items is not a proof that nothing is unsafe: it says that
nothing the tooling saw had verified ownership. A resource with no lease at all is
protected, and a checkout that carries an ignored artifact that is not a known build
output is preserved rather than reused.

`git status --porcelain` does not list ignored paths, so the tooling reads them
separately. An ignored path that is not a known regenerable output — a calibration
verdict, a receipt, a key — is content the checkout holds, and it is preserved: the
checkout is refused for reuse, and the artifact is named in the report so it can be
recovered. This record claims no live acceptance, no native acceptance and no production
readiness.
