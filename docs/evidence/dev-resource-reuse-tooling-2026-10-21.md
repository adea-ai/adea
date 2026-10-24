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

Every lease that names a resource is read, not the first one. A stale lease does not
speak for a live lease that follows it, and an owner whose state cannot be established
is an owner, not an absence: one uncertain lease protects the resource even when the
lease of this run is stale.

A stale worktree is reused only when the local work is already committed, the fetched
origin ref contains the checkout's head, the commits are published, and no live owner
holds it. Local work is never overwritten. A checkout with changes is preserved; a
checkout whose origin is behind is refused until its owner refreshes it. Every refusal
names the condition that failed.

## What the reads have to establish

The review of the tooling found six ways a read could leave a checkout or a resource
looking free when it was not. The rules are now:

- **The ignored paths are read, and an unreadable list refuses.** A checkout whose
  ignored paths could not be read may hold content the report cannot account for, so
  it is refused rather than reused.
- **An ignored path is regenerable only when the repository proves it.** A path's name
  is not a proof: `.wrangler` holds the local persisted state of a development runtime
  and nothing rebuilds it, and a build output may hold an overlay that no rebuild
  reproduces. A path is regenerable only when the tracked tooling that produces it is
  there — the lockfile for a dependency tree, the package manifest for a build output,
  the tracked tool config for a generated file, the tracked sync script for the public
  assets — and when the checkout's tracked sources are the committed ones. Everything
  else is preserved and named.
- **The untracked files are listed.** A repository that sets
  `status.showUntrackedFiles=no` would otherwise hide ordinary untracked work from the
  local-work check, and the checkout would look clean when it is not.
- **The remote is asked what it holds.** A remote-tracking ref can outlive the branch
  it points at: the branch may have been deleted, or the fetch may not carry it. A
  successful fetch is not authority for a branch the remote does not have, so the
  checkout is refused until the remote says it holds the branch.
- **The lease evidence that could not be read reaches the decision.** A record that
  does not parse, a record that is not yet valid, and a lease scan that failed are
  evidence of an unknown owner. They cannot be attributed to a path, so they protect
  everything they may name, and the report names them.
- **Every lease that names a resource is read.** One owner that cannot be established
  protects the resource even when another lease of this run is stale.

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
| Record commit  | `d45e5dd5a` — `docs(evidence): record the #1567 repair heads and the refreshed report`             |
| Review repair  | `709465717` — `fix(scripts): read the ownership and the checkout the way it is (#1567)`            |

Added: `scripts/dev-resource-reuse.mjs` (the model), `scripts/dev-resource-reuse.test.ts`
(the regressions), `scripts/dev-resource-reuse-report.mjs` (the dry-run report runner),
`scripts/dev-resource-reuse-report.test.ts` (the runner-level regressions).

## Commands and evidence

| Check                   | Command                                                                                             | Result                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Focused regression      | `bun test scripts/dev-resource-reuse.test.ts scripts/dev-resource-reuse-report.test.ts`             | 61 pass, 0 fail, 162 expect() calls               |
| Lease model lane        | the focused pair plus `scripts/integration-resource-lease.test.ts`                                  | 164 pass, 0 fail, 473 expect() calls              |
| Repository scripts lane | `bun test scripts/*.test.ts`                                                                        | 1390 pass, 0 fail, 11682 expect() calls, 89 files |
| Formatting              | `bunx oxfmt --check` (the four scripts and this record)                                             | All matched files use the correct format          |
| Lint                    | `bunx oxlint --deny-warnings` (the four scripts)                                                    | 0 warnings, 0 errors                              |
| Command dry run         | `bun scripts/dev-resource-reuse-report.mjs --repo <repo> --fetch --lease-dir <dir> --report <path>` | exit 0, the report below                          |
| Pre-commit gate         | `git commit` → `.githooks/pre-commit` → `code-foundry pre-commit`                                   | `vp run: 33/33 successful`                        |

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

The review repair adds the acquisition-level cases, against controlled temporary
repositories, lease records and read failures rather than injected values: untracked
work listed in a repository that hides it, a remote-tracking ref the remote does not
hold, a lease record that does not parse, a lease record that is not yet valid, a lease
directory that cannot be read, local persisted state beside a proven build output, and
the command itself writing a report and removing nothing.

## The dry-run report on this host

```
bun scripts/dev-resource-reuse-report.mjs --repo <repo> --fetch \
  --lease-dir <lease dir> --report <path>
```

The counts move with the host: the fleet adds and retires checkouts while it runs, so the
numbers below are one run's, and the report is the authority for any later run.

| Field                        | Value              |
| ---------------------------- | ------------------ |
| Docker resources seen        | 34                 |
| Eligible resources           | **0**              |
| Registered checkouts seen    | 15                 |
| Reusable checkouts           | **0**              |
| Preserved                    | 49                 |
| Preservation violations      | 0                  |
| Fetch requested and observed | succeeded          |
| Ownership sources read       | lease records only |

Every reason is recorded. The Docker resources are protected because this run owns no
project and no lease record was present in the inspected directory, so no resource was
provably owned by any run. The checkouts are refused because they carry local work, or
because the remote does not hold their branch, or because their commits are published
nowhere else, or because they carry an ignored artifact the repository does not prove
is regenerable. Five of the fifteen checkouts had a fresh origin in this run; the rest
were refused for a stale one.

No checkout is reusable on this host under these rules, and that is the honest answer:
the previous run named one reusable checkout, and it is preserved now because its
ignored artifacts are not proven to be regenerable and its branch is not held by the
remote. Zero eligible items is not a proof that nothing is unsafe: it says that nothing
the tooling saw had verified ownership.

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
protected, and a checkout that carries an ignored artifact the repository does not prove
is regenerable is preserved rather than reused.

`git status --porcelain` does not list ignored paths, so the tooling reads them
separately, with the untracked files listed explicitly. An ignored path that the
repository does not prove to be regenerable — a calibration verdict, a receipt, a key,
the local state of a development runtime — is content the checkout holds, and it is
preserved: the checkout is refused for reuse, and the artifact is named in the report so
it can be recovered. This record claims no live acceptance, no native acceptance and no
production readiness.
