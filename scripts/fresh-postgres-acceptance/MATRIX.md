# Fresh-account acceptance harness

This opt-in harness covers fresh-account web and desktop authentication without
importing legacy identities, passwords or sessions. It adds no default-suite,
deployment or workflow changes.

The two memory journeys were qualified using a read-only source override to #1466
head `04ed9e20f2cca9bcdb3fe62361e5ca2168ebee6b`. The PostgreSQL fixture has not run:
this branch starts at main `c57334422b3b295b6c8935601d22d37bfabebb30`, which does not
contain the auth APIs/dependencies. Execution needs a reviewed integration baseline
with #1466 and the #1465 owner repairs (published DB head
`0de35bb65ec9707b6d438fa2f4eb1d35deffeccc`). These prerequisites must not be merged
or copied implicitly by the harness.

| Boundary                                                                                           | Executable evidence                                                                               | Result                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Verification-required signup issues no session; unverified login denied                            | web-lifecycle-memory.test.ts, real Better Auth memory adapter and production config/server APIs   | Passed                                          |
| Synthetic mailbox verification gives verified email and secure HTTP-only SameSite cookie           | web-lifecycle-memory.test.ts                                                                      | Passed                                          |
| Missing/hostile-origin password reset creates no delivery                                          | web-lifecycle-memory.test.ts                                                                      | Passed                                          |
| Reset consumes token once, deletes previous sessions, refuses old password                         | web-lifecycle-memory.test.ts                                                                      | Passed                                          |
| Expired reset rejected, no session/cookie; current password still works                            | web-lifecycle-memory.test.ts, modifies one synthetic memory record deadline                       | Passed                                          |
| Browser logout and explicit revoke invalidate saved cookie replay                                  | web-lifecycle-memory.test.ts                                                                      | Passed                                          |
| Every browser response including denial is no-store                                                | web-lifecycle-memory.test.ts                                                                      | Passed                                          |
| Missing/hostile-origin desktop exchange preserves one-use PKCE code                                | desktop-origin-revocation.test.ts, real broker/client/parser/service primitives and memory stores | Passed                                          |
| Trusted PKCE exchange works once; refresh rotates credential                                       | desktop-origin-revocation.test.ts                                                                 | Passed                                          |
| Origin-denied desktop logout preserves session; trusted logout revokes                             | desktop-origin-revocation.test.ts                                                                 | Passed                                          |
| Saved desktop credential fails refresh/revoke after logout                                         | desktop-origin-revocation.test.ts                                                                 | Passed                                          |
| Desktop response no-store, no hostile CORS reflection, no credential URLs                          | desktop-origin-revocation.test.ts                                                                 | Passed                                          |
| Provider/app schema creation, replay, runtime DML and DDL denial                                   | fixture.ts and auth-lifecycle.ts                                                                  | Not run; reviewed integration baseline required |
| Actual web route registration, native vault/OS callback, PKCE authorization route identity mapping | Not exercised by these memory compositions                                                        | Pending separate qualification                  |
| Hosted strict TLS, Hyperdrive/cache behavior, production delivery                                  | Not exercised by plaintext-free memory tests                                                      | Pending owner qualification                     |

## Memory qualification and ordinary discovery

Dedicated command (source override reads existing reviewed code without copying it):

```sh
FRESH_AUTH_SOURCE_ROOT=<existing-reviewed-auth-checkout> \
  node scripts/fresh-postgres-acceptance/run.mjs --memory
```

After #1466 is integrated into an approved baseline, omit the source override.
The memory runner checks source prerequisites before executing tests, provides a
clean child environment, enables the explicit acceptance flag, and requires both
journeys to execute. Missing prerequisites, failures or skipped journeys fail the
explicit command; they never produce a pass receipt. It never imports provisioning.

Ordinary test discovery without `FRESH_AUTH_ACCEPTANCE=1` or a source override
records these two journeys as named **dedicated opt-in skips** without importing
the unavailable auth dependencies. A focused ordinary-discovery check produced
0 passed, 2 skipped, 0 failed on this base. Those skips are not acceptance evidence.
The configured root coverage lane selects `scripts/*.test.ts`, so these nested
acceptance files do not enter that lane. No CI/workflow applicability is changed.
The always-runnable policy tests cover the fail-closed entry and environment gates.

Result: 2 passed, 0 failed under Bun 1.4.3. The expected invalid-password warning
contained no credentials. These are complete synthetic journeys, not end-to-end
browser/native/deployment or PostgreSQL receipts. Verification replay is deliberately
not asserted single-use: Better Auth 1.6.23 accepts already-verified mailbox replay.
Desktop grant lifetime is separate from browser provider-session lifetime.

## Policy checks and PostgreSQL opt-in

Run from the repository root:

```sh
node --test scripts/fresh-postgres-acceptance/policy.test.mjs
node scripts/fresh-postgres-acceptance/run.mjs --preflight
```

The seven policy tests run without dependencies or a database. Preflight checks source and
manifest prerequisites and exits before importing the provisioner. It currently
fails on this base because #1466 is absent; that failure is expected and is not a
PostgreSQL test pass. The source override is for memory tests only and is never
used to construct an unreviewed app/auth integration baseline.

After root approves the integration baseline, install that baseline's locked
dependencies and run the isolated PostgreSQL lane through the Fleet heavy wrapper:

```sh
python3 "$FLEET_HEAVY" -- node scripts/fresh-postgres-acceptance/run.mjs
```

`FLEET_HEAVY` names the existing Fleet heavy-job scheduler. The runner accepts no
external database target. Before importing the provisioner, it reads Docker context
metadata, rejects configured remote endpoints/TLS overrides, and pins its process to
a validated local unix/npipe socket through cleanup and exit handlers. It never
changes the caller environment or persistent Docker context. These guards are
unit-tested with synthetic metadata; no Docker inspection/provisioning was run for
this receipt. Its existing provisioner creates a disposable PostgreSQL
18 instance bound to loopback with a random password. A new random database uses
canonical migration/runtime roles. It applies product migrations twice and compares
the journal, checks empty product identity/workspace tables, initializes the separate
`auth_acceptance` schema using provider tooling, then exercises provider DML through
the runtime role. It checks runtime schema DDL denial and the full auth lifecycle.

The child receives only PATH/TMPDIR/LANG and fixture-owned database variables; Bun
automatic environment-file loading is disabled. No inherited auth/database/mail/PG
routing settings enter the child. Cleanup closes handles and drops the exact scratch
database, and the runner removes its owned container on completion or failure. Raw
child output is withheld because it may contain credentials or tokens. A missing
fixture or failed cleanup makes the lane fail; it never reports a skipped pass.

The only new files are in `scripts/fresh-postgres-acceptance/`. Existing auth, DB,
web and desktop implementations, fixtures, manifests, locks and workflows are unchanged.
