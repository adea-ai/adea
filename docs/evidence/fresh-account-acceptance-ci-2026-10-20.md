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

## Evidence

| Command                                                           | Result                                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test scripts/ci-fresh-account-acceptance.test.ts`            | 21 pass, 0 fail                                                                                                                        |
| `bun test scripts/database-proof-workflow.test.ts`                | 23 pass, 0 fail                                                                                                                        |
| `bun test scripts/ci-fresh-account-acceptance.test.ts --coverage` | `scripts/ci-fresh-account-acceptance.mjs` at 100% functions and 99.17% lines (the one uncovered line is the program's own entry guard) |
| `oxfmt --check` on the three changed sources                      | all files use the correct format                                                                                                       |
| `oxlint --deny-warnings` on the three changed sources             | no findings                                                                                                                            |

The gate's own tests cover the exact-head refusal, the dirty-tree refusal, the
foreign-tree refusal, the zero-pass refusal for each measured count, the
no-refusal refusal for each refused case, the simulated and failed results, a
run that printed no receipt, the usage error, and the program's exit codes in
both directions. The workflow's structural test covers the job's identity, the
draft filter, the checkout ref, the step order, the artifact, the container
check, and that the job reads no secret and names no provider.

## Scope

Three paths, all in this lane's scope:

- `.github/workflows/database-proof.yml` — the job.
- `scripts/ci-fresh-account-acceptance.mjs` — the CI-side gate.
- `scripts/ci-fresh-account-acceptance.test.ts` — the gate's tests.
- `scripts/database-proof-workflow.test.ts` — the workflow's structural test.

No file of the acceptance lane's own is touched, no existing check is removed
or renamed, no coverage threshold is lowered, and the draft pull request runs
no job at all.
