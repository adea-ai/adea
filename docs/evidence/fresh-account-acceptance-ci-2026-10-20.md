# The fresh-account acceptance lane runs in CI

Branch: `codex/20261020-ci-fresh-account-acceptance`. Base: `origin/main` =
`129231ee823e794de722c341475737957e8633bd` ("feat(acceptance): qualify the
Railway fresh-Postgres lane and its recovery (#1514)").

Read on 2026-10-20 from a local checkout. No credential was read, no secret was
created or changed, no hosted database was reached, no branch was created or
deleted anywhere, and no release, deploy or readiness change was made.

## The gap this closes

The acceptance lane that qualifies a fresh self-hosted account — the real
provider lifecycle and the desktop principal journey against a real disposable
PostgreSQL 18 — is `node scripts/fresh-postgres-acceptance/run.mjs`. Its owner
records it as **local only**: the fresh-account acceptance lane was "not in CI",
because the workflow files belong to another lane, and the wiring was handed
over with the exact job it needs.

That handoff is `data/operator-handoffs/20261020-railway-lane-a-ci-wiring-handoff-f.json`
in the fleet's data directory (the acceptance lane's own PR body names the
same record). It specifies the job: the name, the runner, the timeout, the
draft filter, the toolchain steps, the entrypoint, and the receipt artifact.

The gap was still open on `main` when this branch was cut:

- no workflow named `scripts/fresh-postgres-acceptance` (verified with
  `git grep -n "fresh-postgres-acceptance" origin/main -- .github/`, empty);
- the merge of #1516 did not add the entrypoint to the disposable CI workflow
  (it replaced the provider branch lane and left the disposable proof as it
  was);
- the acceptance lane's own runner was available on a stable exact head:
  #1514 was merged as `129231ee8`, so `scripts/fresh-postgres-acceptance/run.mjs`
  is on `main` and is the exact code this job runs.

## The job

`.github/workflows/database-proof.yml` gains one job, `fresh_account_acceptance_proof`
(check name "Fresh account acceptance proof"), beside the two it already had.
The existing proof job and the existing fail-closed gate are unchanged.

The job, in order:

1. **The exact head, not the merge commit.** The checkout names
   `github.event.pull_request.head.sha`, and the same value is the job's
   `EXPECTED_HEAD`. The receipt the lane prints must name that commit: a
   receipt that names any other commit is not a proof of this pull request.
   The merge result is still proven — by the validation lane, which checks it
   out itself.
2. **The pinned toolchain**, the same steps the disposable proof job uses: Bun
   1.4.3, `bun install --frozen-lockfile`, and the PostgreSQL 18 client tools
   from apt.postgresql.org, with the versions checked before anything runs.
3. **The workspace packages the phase imports** are built
   (`packages/types`, `packages/auth`).
4. **The acceptance lane's own entrypoint**, unchanged:
   `node scripts/fresh-postgres-acceptance/run.mjs`. Its stdout goes to
   `$RUNNER_TEMP`, outside the checkout, so the tree the receipt names is still
   the clean tree the run happened in. The lane provisions its own disposable
   instance and removes it on success, on failure and on interruption, and
   fails the run when it cannot.
5. **No container is left behind.** The job fails when a container of the
   lane's own naming is still running, rather than reporting a proof next to a
   leak.
6. **The receipt is gated before anything is published.**
   `scripts/ci-fresh-account-acceptance.mjs` refuses a receipt that is not the
   lane's own passed database proof, that names another commit, whose tree was
   not clean, whose code came from another tree, that shows no measured account,
   mapping or exchange, that refused no case, or that did not run the real
   provider. A refused receipt writes no artifact and fails the job.
7. **The receipt is published** as the `fresh-account-acceptance-receipt`
   artifact, with `if-no-files-found: error`.

## What the gate reuses rather than restates

The gate imports the acceptance lane's own contract — `assertDatabaseProof`
from `scripts/fresh-postgres-acceptance/recovery.mjs`,
`assertReproducibleProvenance` from `.../provenance.mjs` and
`classifyDisposableProofEvidence` from `.../evidence.mjs`. A receipt qualifies
in CI exactly when it qualifies in the lane. No file under
`scripts/fresh-postgres-acceptance/**` is edited, and no part of the lane's
implementation is copied.

The published artifact keeps the lane's own class beside the class the source
may claim: `laneEvidence` is the lane's `local-disposable`, and `evidence` is
the `ci` class the acceptance lane's own helper computes for a run that
happened in CI. The relabel hides nothing.

## The failure and cleanup semantics

The job only means something if a failed run cannot look like a proof. The
failure paths are qualified for real: the lane is run against a fake repository
in which its three seams — the provisioner, the fixture and the focused
journey — are replaced with fakes, so every path is exercised without a
container. The lane itself is not changed, and no part of it is copied.

| Path                                    | What the lane does                                       | What the pull-request lane sees                    |
| --------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| setup failure                           | the provisioner fails, the run exits 1                   | no receipt, the failure named, no artifact         |
| migration failure                       | the fixture fails, the run exits 1                       | no receipt, the failure named, no artifact         |
| test failure                            | the focused journey fails, the run exits 1               | no receipt, the failure named, no artifact         |
| skipped journey                         | the journey is skipped, the run exits 1                  | no receipt, the skip named, no artifact            |
| missing journey receipt                 | the journey printed no receipt, the run exits 1          | no receipt, the gap named, no artifact             |
| cleanup failure                         | the owned instance could not be removed, the run exits 1 | no receipt, the cleanup failure named, no artifact |
| a primary failure and a cleanup failure | both are reported, the run exits 1                       | no receipt, both failures named, no artifact       |
| cancellation                            | the run is terminated, it prints nothing                 | no receipt, no artifact                            |
| the job's hard timeout                  | the run is killed, it prints nothing                     | no receipt, no artifact                            |

Three properties hold on every one of those paths:

- **No passed receipt.** The lane prints its receipt only when nothing failed,
  and the gate refuses output that carries no receipt. A refused receipt writes
  no artifact, so the job publishes no proof of a run that failed.
- **The primary failure and the cleanup failure are both reported.** The lane
  catches the primary failure and reports it, and the cleanup failure is
  reported next to it; the workflow's container check runs even when the lane
  failed, so a leaked instance is reported next to the failure instead of
  being hidden by it.
- **Only owned resources are removed, and the evidence is sanitized.** The
  lane stops the instance it created and nothing else, and it never prunes. The
  failure evidence names the failure and nothing else: the child's raw output,
  which may carry the URL and its parameters, is never relayed, and the
  published receipt carries the commit, the class and the measured counts and
  no credential.

The lifecycle result fields are the acceptance lane's own. They are asserted
to survive — from the fixture's measured counts into the lane's receipt, and
from there into the published artifact — and they are not redesigned here.

The lane's own child timeouts (180 s for the fixture, 600 s for the focused
journey, each with a kill signal) are pinned by the boundary test, and the
lane's own structure — the receipt only on success, the exit code, the two
reported failures, the owned instance, the unrelayed child output — is pinned
there too. The run/teardown/receipt boundary test is the acceptance lane's
boundary; this lane scopes it to those properties and changes nothing else.

## Evidence

| Command                                                           | Result                                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test scripts/ci-fresh-account-acceptance.test.ts`            | 21 pass, 0 fail                                                                                                                        |
| `bun test scripts/ci-fresh-account-acceptance-failure.test.ts`    | 14 pass, 0 fail                                                                                                                        |
| `bun test scripts/database-proof-workflow.test.ts`                | 26 pass, 0 fail                                                                                                                        |
| `bun test scripts/desktop-principal-acceptance-boundary.test.ts`  | 13 pass, 0 fail                                                                                                                        |
| `bun test scripts/ci-fresh-account-acceptance.test.ts --coverage` | `scripts/ci-fresh-account-acceptance.mjs` at 100% functions and 99.17% lines (the one uncovered line is the program's own entry guard) |
| `oxfmt --check` on the changed sources                            | all files use the correct format                                                                                                       |
| `oxlint --deny-warnings` on the changed sources                   | no findings                                                                                                                            |

The gate's own tests cover the exact-head refusal, the dirty-tree refusal, the
foreign-tree refusal, the zero-pass refusal for each measured count, the
no-refusal refusal for each refused case, the simulated and failed results, a
run that printed no receipt, the usage error, and the program's exit codes in
both directions. The failure qualification covers the nine paths in the table
above, and the gate's refusal of a failed run and of a receipt from another
tree. The workflow's structural test covers the job's identity, the draft
filter, the checkout ref, the step order, the artifact, the container check, the
fail-closed shape of the publish step, and that the job reads no secret, names
no provider and removes nothing.

## Scope

Five paths, all in this lane's scope or in the boundary this lane scopes:

- `.github/workflows/database-proof.yml` — the job, and the fail-closed shape of
  its steps.
- `scripts/ci-fresh-account-acceptance.mjs` — the CI-side gate.
- `scripts/ci-fresh-account-acceptance.test.ts` — the gate's tests.
- `scripts/ci-fresh-account-acceptance-failure.test.ts` — the failure and
  cleanup qualification.
- `scripts/database-proof-workflow.test.ts` — the workflow's structural test.
- `scripts/desktop-principal-acceptance-boundary.test.ts` — the run/teardown/
  receipt boundary test, scoped to the lane's fail-closed structure.

No file of the acceptance lane's own is touched, no existing check is removed
or renamed, no coverage threshold is lowered, and the draft pull request runs
no job at all.
