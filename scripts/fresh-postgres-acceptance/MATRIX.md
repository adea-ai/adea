# Fresh-account acceptance harness

This opt-in harness covers fresh-account web and desktop authentication without
importing legacy identities, passwords or sessions. It adds no default-suite,
deployment or workflow changes.

This branch integrates current `origin/main` (`52071913442a47810dd1092c6cc65dde3669b6b9`),
which contains the merged direct/pooled PostgreSQL qualification #1465 (reviewed PR head
`417f01d0058a4eae7799459cd7ef6b23c2ea60aa`, squash commit
`52071913442a47810dd1092c6cc65dde3669b6b9`) and the merged self-hosted Better Auth boundary
#1466 (`c32221e4a6eced7e7dbd9e9e58b380ca3396d7a5`). Its `packages/auth/src` is byte-identical
to the previously reviewed #1466 head `04ed9e20f2cca9bcdb3fe62361e5ca2168ebee6b`, so both
memory journeys and the PostgreSQL fixture use the integrated in-repository baseline with no
source override. The disposable PostgreSQL lane is now unblocked; its result is recorded below.

| Boundary                                                                                                            | Executable evidence                                                                                | Result                                          |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Verification-required signup issues no session; unverified login denied                                             | web-lifecycle-memory.test.ts, real Better Auth memory adapter and production config/server APIs    | Passed                                          |
| Synthetic mailbox verification gives verified email and secure HTTP-only SameSite cookie                            | web-lifecycle-memory.test.ts                                                                       | Passed                                          |
| Missing/hostile-origin password reset creates no delivery                                                           | web-lifecycle-memory.test.ts                                                                       | Passed                                          |
| Reset consumes token once, deletes previous sessions, refuses old password                                          | web-lifecycle-memory.test.ts                                                                       | Passed                                          |
| Expired reset rejected, no session/cookie; current password still works                                             | web-lifecycle-memory.test.ts, modifies one synthetic memory record deadline                        | Passed                                          |
| Browser logout and explicit revoke invalidate saved cookie replay                                                   | web-lifecycle-memory.test.ts                                                                       | Passed                                          |
| Every browser response including denial is no-store                                                                 | web-lifecycle-memory.test.ts                                                                       | Passed                                          |
| Missing/hostile-origin desktop exchange preserves one-use PKCE code                                                 | desktop-origin-revocation.test.ts, real broker/client/parser/service primitives and memory stores  | Passed                                          |
| Trusted PKCE exchange works once; refresh rotates credential                                                        | desktop-origin-revocation.test.ts                                                                  | Passed                                          |
| Origin-denied desktop logout preserves session; trusted logout revokes                                              | desktop-origin-revocation.test.ts                                                                  | Passed                                          |
| Saved desktop credential fails refresh/revoke after logout                                                          | desktop-origin-revocation.test.ts                                                                  | Passed                                          |
| Desktop response no-store, no hostile CORS reflection, no credential URLs                                           | desktop-origin-revocation.test.ts                                                                  | Passed                                          |
| PKCE callback state/nonce binding, attempt and server-code expiry, replay and credential-carrying callbacks refused | desktop-origin-revocation.test.ts, shared desktop.ts callback boundary and broker code TTL         | Passed                                          |
| Provider/app schema creation, replay, runtime DML and DDL denial                                                    | fixture.ts and auth-lifecycle.ts; disposable loopback PostgreSQL 18                                | Passed; 59 migrations, verification required    |
| A fresh provider identity maps to exactly one application user, and a second identity stays separate                | desktop-principal-lifecycle.ts; the production principal resolution over the production database   | Passed; better-auth subject to one app user     |
| Repeated and concurrent provisioning of one identity is idempotent, and leaves one mapping                          | desktop-principal-lifecycle.ts; the production identity functions and the production join          | Passed; concurrent inserts converge on one user |
| The three fresh identities are distinct, and the measured account and user deltas leave no orphan user              | desktop-principal-lifecycle.ts; the measured provider accounts, application users and orphan users | Passed; 3 accounts, 3 users, 0 orphans          |
| The desktop PKCE exchange persists the mapped identity, and refuses a hostile origin, a wrong verifier and a replay | desktop-principal-lifecycle.ts; the production brokers, stores and the exchange request parser     | Passed; one session, three refusals             |
| A refresh invalidates the predecessor credential and a logout revokes the persisted credential                      | desktop-principal-lifecycle.ts; the production desktop session service over the production store   | Passed                                          |
| Actual web route registration of the desktop authorize and exchange paths in the built Worker                       | Not exercised here; the routes bind the framework request scope and the hosted provider adapter    | Pending a later dependency                      |
| Native vault and OS callback storage                                                                                | Not exercised by these compositions                                                                | Pending owner qualification                     |
| Hosted strict TLS, Hyperdrive/cache behavior, production delivery                                                   | Not exercised by plaintext-free memory tests                                                       | Pending owner qualification                     |

## Memory qualification and ordinary discovery

Dedicated command against the integrated baseline (no source override):

```sh
node scripts/fresh-postgres-acceptance/run.mjs --memory
```

The memory runner checks source prerequisites before executing tests, provides a
clean child environment, enables the explicit acceptance flag, and requires both
journeys to execute. Missing prerequisites, failures or skipped journeys fail the
explicit command; they never produce a pass receipt. It never imports provisioning.
`--memory --preflight` passes source prerequisites on the integrated branch and
starts no tests or database.

Ordinary test discovery without `FRESH_AUTH_ACCEPTANCE=1` records these two journeys
as named **dedicated opt-in skips**; they are not acceptance evidence. A focused
ordinary-discovery check produced 0 passed, 2 skipped, 0 failed. The configured root
coverage lane selects `scripts/*.test.ts`, so these nested acceptance files do not
enter that lane. No CI/workflow applicability is changed. The always-runnable policy
tests cover the fail-closed entry and environment gates, including a synthetic gate
that refuses a pass receipt for an incomplete or skipped memory run.

Result: 2 passed, 0 failed under Bun 1.4.3, with no source override. The expected
invalid-password warning contained no credentials. These are complete synthetic
journeys, not end-to-end browser/native/deployment or PostgreSQL receipts.
Verification replay is deliberately not asserted single-use: Better Auth 1.6.23
accepts already-verified mailbox replay. Desktop grant lifetime is separate from
browser provider-session lifetime.

## Policy checks and PostgreSQL opt-in

Run from the repository root:

```sh
node --test scripts/fresh-postgres-acceptance/policy.test.mjs
node scripts/fresh-postgres-acceptance/run.mjs --preflight
```

The eleven policy tests run without dependencies or a database. Preflight checks source
and manifest prerequisites and exits before importing the provisioner. On the integrated
baseline the fresh-schema preflight passes its source/manifest prerequisites and stops
before Docker/provisioning. The source override is for memory tests only and is never used to
construct an unreviewed app/auth integration baseline; the memory lane no longer needs it.

The reviewed combined baseline includes #1465's squash commit
`52071913442a47810dd1092c6cc65dde3669b6b9`. After a frozen install, the isolated PostgreSQL
lane ran through the Fleet heavy wrapper and emitted this receipt:

```sh
python3 "$FLEET_HEAVY" -- node scripts/fresh-postgres-acceptance/run.mjs
```

`FLEET_HEAVY` names the existing Fleet heavy-job scheduler. The runner accepts no
external database target. Before importing the provisioner, it reads Docker context
metadata, rejects configured remote endpoints/TLS overrides, and pins its process to
a validated local unix/npipe socket through cleanup and exit handlers. It never
changes the caller environment or persistent Docker context. These guards are
unit-tested with synthetic metadata. Its existing provisioner creates a disposable PostgreSQL
18 instance bound to loopback with a random password. A new random database uses
canonical migration/runtime roles. It applies product migrations twice and compares
the journal, checks empty product identity/workspace tables, initializes the separate
`auth_acceptance` schema through the shared `applyAuthSchema()` in
`packages/auth/src/schema-init.ts` (apply, then a no-op replay), then exercises provider DML through
the runtime role. It checks runtime schema DDL denial and the full auth lifecycle.

The completed local receipt was
`{"status":"passed","migrations":59,"verificationRequired":true,"desktopPrincipal":{"accounts":3,"exchanges":1,"mappedUsers":3,"orphanUsers":0,"provider":"better-auth","refused":{"origin":1,"pkce":1,"replay":1}}}`.
The child receives only PATH/TMPDIR/LANG and fixture-owned database variables; Bun
automatic environment-file loading is disabled. No inherited auth/database/mail/PG
routing settings enter the child. Cleanup closes handles and drops the exact scratch
database, and the runner removes its owned container on completion or failure. Raw
child output is withheld because it may contain credentials or tokens. A missing
fixture or failed cleanup makes the lane fail without emitting a passed receipt.
The passed receipt is emitted only after owned cleanup succeeds; synthetic tests
cover both cleanup failure and receipt ordering. It never reports a skipped pass.

## The desktop principal lifecycle phase

`desktop-principal-lifecycle.ts` adds one phase to that lane. It drives the real
self-hosted Better Auth provider over a fresh account, resolves the provider
identity through the production principal resolution
(`resolveOrProvisionDesktopPrincipal`), and exercises the production database
identity functions and the production desktop code and session brokers over the
production PostgreSQL stores. It mocks no identity mapping and keeps no identity
state in memory: the application users, the authorization codes and the desktop
sessions are rows in the disposable database.

`fixture.ts` only invokes that phase and closes the runtime connection it owns;
the phase opens and closes its own application connection.

The real database execution of the phase belongs to the dedicated opt-in lane.
`run.mjs` validates the Docker target, pins its process to a local socket for
its whole lifetime, isolates the child environment, provisions the disposable
instance and hands it to the focused test. The focused test
`desktop-principal-lifecycle.test.ts` never starts a container and never
contacts a Docker daemon: without the lane's instance its database journey is a
named dedicated opt-in skip, so ordinary test discovery finds the file
side-effect-free, and the lane fails when the journey is skipped.

The lane runs the phase twice, in two scratch databases: once through the
fixture, whose receipt carries the measured counts, and once through the focused
journey.

```sh
python3 "$FLEET_HEAVY" -- node scripts/fresh-postgres-acceptance/run.mjs
```

The counts in the receipt are measured, never assumed. The phase measures the
provider accounts, the application users and the application users that carry no
provider identity before and after it runs, and it requires one account and one
user per identity with no orphan user. A concurrent provisioning loser that
left a user behind would raise the user count without raising the mapping
count, and that is a failure rather than a pass.

The cleanup of the focused journey is fatal. Every owned connection is closed
even when an earlier close fails, the scratch database is dropped and the
administrative connection is closed last, and the aggregated cleanup failures
fail the run instead of leaving it green.

The offline regressions in the ordinary unit lane
(`scripts/desktop-principal-acceptance-boundary.test.ts`) cover the
boundaries: the focused journey must never provision, the dedicated lane must
validate and pin its local Docker target, and a failed cleanup step must be
collected while the remaining steps still run. The measured counts are
rejected by the **nested focused test**
(`scripts/fresh-postgres-acceptance/desktop-principal-lifecycle.test.ts`), not by
that boundary test: it refuses a missing account, a missing user and an orphan
user. The nested focused test also runs the database journey, and the
dedicated lane requires the journey receipt it prints, so a result that
executed no journey at all is rejected.

The phase needs the built workspace packages, because the production principal
resolution imports `@adea-ai/auth` as a package rather than a source path:

```sh
bun run --cwd packages/types build && bun run --cwd packages/auth build
```

## What this phase does not prove

- **The built Worker route registration.** The desktop authorize and exchange
  routes bind the framework request scope and, for the authorize route, the
  hosted provider adapter. This phase exercises the request path the exchange
  route composes, not a Worker that registers it. That is a later dependency.
- **The joined delivery qualification.** It stays blocked until the active
  server-only delivery work merges. The pending head at the time of writing is
  `4cc6195b2443affe47bcf56032928006fe24fe22` (PR #1478, `claude/auth-delivery-r2`,
  open, draft, auto-merge off). The joined qualification must record the exact
  joined head it ran against; the head above is the dependency, not a joined
  result.
- **Native vault and OS callback storage, hosted strict TLS, Hyperdrive and
  production delivery.** These stay with their own owners.

The only new files are in `scripts/fresh-postgres-acceptance/`. Existing auth, DB,
web and desktop implementations, fixtures, manifests, locks and workflows are unchanged.
