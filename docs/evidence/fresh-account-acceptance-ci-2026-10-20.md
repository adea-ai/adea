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
   The lane and the gate are Node programs, so the job also installs the
   repository's Node runtime — the version `.mise.toml` pins — and not
   whatever the runner image happens to carry.
3. **The workspace packages the phase imports** are built
   (`packages/types`, `packages/auth`).
4. **The acceptance lane's own entrypoint**, unchanged:
   `node scripts/fresh-postgres-acceptance/run.mjs`. Its stdout goes to
   `$RUNNER_TEMP`, outside the checkout, so the tree the receipt names is still
   the clean tree the run happened in. The lane provisions its own disposable
   instance and removes it on success, on failure and on interruption, and
   fails the run when it cannot.
5. **No instance is left behind.** The names that were running before the lane
   starts are recorded, and the names that are running afterwards are compared
   with them: the containers that appeared while the run executed are the ones
   the run created, and the check looks only at those. It is not a prefix
   sweep, and it never removes anything. A container that is still running is
   reported by name and the job fails, so the cleanup failure is recorded next
   to the primary failure instead of being hidden by it. The check runs even
   when the lane failed and even when the job was cancelled.
6. **The receipt is gated before anything is published.**
   `scripts/ci-fresh-account-acceptance.mjs` refuses a receipt that is not the
   acceptance lane's own proof kind, that is not the lane's own passed
   database proof, that names another commit, whose tree was not clean, whose
   code came from another tree, that shows no measured account, mapping or
   exchange, that shows an orphan user, that refused no case, or that did not
   run the real provider. A refused receipt writes no artifact and fails the
   job.
7. **The receipt is published** as the `fresh-account-acceptance-receipt`
   artifact, with `if-no-files-found: error`.

The existing fail-closed aggregate now covers this result as well: the
`Prove Disposable PostgreSQL` gate requires the disposable proof **and** the
fresh-account acceptance proof. Its check name, its threshold and its shape
are unchanged; a failed, cancelled, skipped or missing acceptance result
fails it, exactly as a failed disposable proof does.

## What the gate reuses rather than restates

The gate imports the acceptance lane's own contract — `assertDatabaseProof`
from `scripts/fresh-postgres-acceptance/recovery.mjs`,
`assertReproducibleProvenance` from `.../provenance.mjs` and
`classifyDisposableProofEvidence` from `.../evidence.mjs`. A receipt qualifies
in CI exactly when it qualifies in the lane. No file under
`scripts/fresh-postgres-acceptance/**` is edited, and no part of the lane's
implementation is copied.

The shared check accepts every proof kind the repository knows, and the
disposable proof's receipt is a different proof of a different thing, so the
gate requires the acceptance lane's own kind — `fresh-schema-acceptance` — and
its own lifecycle result: every identity the journey created is owned by an
account, so a receipt that carries an orphan user is refused. The lane's
happy path is unaffected: the receipt it prints already names that kind and
already reports no orphan user.

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

The qualification is hermetic. The lane reads the selected Docker context
before it provisions anything, and it refuses a TLS or a certificate
override, so the run is handed a validated synthetic local endpoint, every
Docker setting the caller may have is removed, and the qualification's own
Docker answers the discovery in place of the runner's. The qualification
therefore does not depend on the machine's Docker, and it is also qualified
for the two refusals that make that matter: a run whose Docker cannot be
discovered, and a run that carries a hostile Docker setting, both fail closed
and publish no receipt.

| Path                                    | What the lane does                                       | What the pull-request lane sees                     |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- |
| setup failure                           | the provisioner fails, the run exits 1                   | no receipt, the failure named, no artifact          |
| migration failure                       | the fixture fails, the run exits 1                       | no receipt, the failure named, no artifact          |
| test failure                            | the focused journey fails, the run exits 1               | no receipt, the failure named, no artifact          |
| skipped journey                         | the journey is skipped, the run exits 1                  | no receipt, the skip named, no artifact             |
| missing journey receipt                 | the journey printed no receipt, the run exits 1          | no receipt, the gap named, no artifact              |
| cleanup failure                         | the owned instance could not be removed, the run exits 1 | no receipt, the cleanup failure named, no artifact  |
| a primary failure and a cleanup failure | both are reported, the run exits 1                       | no receipt, both failures named, no artifact        |
| cancellation                            | the run is interrupted, it prints nothing                | no receipt, the owned instance removed, no artifact |
| the runner destroyed the run            | the run is killed, it prints nothing                     | no receipt, no artifact                             |

Four properties hold on every one of those paths:

- **No passed receipt.** The lane prints its receipt only when nothing failed,
  and the gate refuses output that carries no receipt. A refused receipt writes
  no artifact, so the job publishes no proof of a run that failed.
- **The primary failure and the cleanup failure are both reported.** The lane
  catches the primary failure and reports it, and the cleanup failure is
  reported next to it; the workflow's leak check runs even when the lane
  failed, so a leaked instance is reported next to the failure instead of
  being hidden by it.
- **Only the owned instance is removed, and the cleanup is verified.** The run
  removes the instance it created and nothing else, and it never prunes. The
  instance is a real resource — a directory the provisioner creates and
  removes — so the qualification sees a real resource settled rather than a
  marker. The removal is checked on every path: a run that failed, a run
  whose journey was skipped and an interrupted run are all seen to remove
  their own instance. A run the **runner destroyed** cannot: a killed process
  runs no finally block, so it cannot settle what it owned, and nothing here
  claims that it did. The runner's own teardown is what ends that instance,
  and the pull-request lane's leak check reports it by name if it outlives
  the run. The cleanup qualification for a destroyed run therefore stays
  **pending**.
- **The run's own child and output settle.** The qualification waits, for a
  bounded time, for the run's child to finish before it removes the fake
  repository, and it reads the run's output when the output is closed rather
  than when the process ends, because a child the run left behind still holds
  the output open. A parent that exits proves nothing about either, and the
  qualification no longer takes the parent's word for it.
- **The evidence is sanitized.** The failure evidence names the failure and
  nothing else: the child's raw output, which may carry the URL and its
  parameters, is never relayed, and the published receipt carries the commit,
  the class and the measured counts and no credential.

The lifecycle result fields are the acceptance lane's own. They are asserted
to survive — from the fixture's measured counts into the lane's receipt, and
from there into the published artifact — and they are not redesigned here.

The lane's own child timeouts (180 s for the fixture, 600 s for the focused
journey, each with a kill signal) are pinned by the boundary test, and the
lane's own structure — the receipt only on success, the exit code, the two
reported failures, the owned instance, the unrelayed child output — is pinned
there too. The provisioner's own contract is pinned there as well: it ties the
instance to the process, so a normal exit and an interrupt both remove it and
the removal happens once. The run/teardown/receipt boundary test is the
acceptance lane's boundary; this lane scopes it to those properties and
changes nothing else.

The gate's own program is run with Node, the runtime the job uses, and not
only with the test runner's own binary: the CLI tests spawn `node`, so the
program the job runs is the program the qualification exercises.

## Evidence

| Command                                                           | Result                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test scripts/ci-fresh-account-acceptance.test.ts`            | 23 pass, 0 fail                                                                                                                           |
| `bun test scripts/ci-fresh-account-acceptance-failure.test.ts`    | 18 pass, 0 fail                                                                                                                           |
| `bun test scripts/database-proof-workflow.test.ts`                | 29 pass, 0 fail                                                                                                                           |
| `bun test scripts/desktop-principal-acceptance-boundary.test.ts`  | 14 pass, 0 fail                                                                                                                           |
| `bun run test:coverage` (the full unit coverage lane)             | 2147 pass, 0 fail across 159 files                                                                                                        |
| `bun test scripts/ci-fresh-account-acceptance.test.ts --coverage` | `scripts/ci-fresh-account-acceptance.mjs` at 100.00% functions and 99.21% lines (the one uncovered line is the program's own entry guard) |
| `oxfmt --check` on the changed sources                            | all files use the correct format                                                                                                          |
| `oxlint --deny-warnings` on the changed sources                   | no findings                                                                                                                               |

The gate's own tests cover the wrong-proof-kind refusal, the orphan-user
refusal, the exact-head refusal, the dirty-tree refusal, the foreign-tree
refusal, the zero-pass refusal for each measured count, the no-refusal
refusal for each refused case, the simulated and failed results, a run that
printed no receipt, the usage error, and the program's exit codes in both
directions. The failure qualification covers the nine paths in the table
above, the removal of the owned instance on each of them, the gate's refusal
of a failed run and of a receipt from another tree, and the sanitized
evidence. The workflow's structural test covers the job's identity, the draft
filter, the checkout ref, the pinned Node runtime, the step order, the
artifact, the owned-instance leak check, the fail-closed aggregate over both
results, the fail-closed shape of the publish step, and that the job reads no
secret, names no provider and removes nothing.

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
