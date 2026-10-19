# Fresh PostgreSQL acceptance

This acceptance plan covers a new PostgreSQL target for fresh accounts. It records
what must be proved before a Railway database change can proceed. It does not
authorize provisioning, traffic changes, deployment or the start of the cost week.
Existing Neon data stays recoverable throughout this work.

The application, authentication provider and Control Plane own separate migration
boundaries. A successful migration of one does not initialize the others.

## Implementation prerequisites

The proposed self-hosted authentication boundary is tracked in
[Adea #1466](https://github.com/adea-ai/adea/pull/1466), and direct/pooled connection
qualification in [Adea #1465](https://github.com/adea-ai/adea/pull/1465). Their reviewed
resulting heads and applicable passing checks are prerequisites for combined
acceptance. A test of an earlier candidate cannot qualify a later repair.

The #1466 candidate documents that provider schema initialization is not yet wired
into a deployment step. Its PostgreSQL fixture initializes provider tables directly
and disables verification for its persistence test. Record these limits explicitly;
neither fact proves a fresh deployment with verification required.

Do not import old identities, passwords, sessions or application data. Do not add
dual writes or reconcile old records. Create synthetic accounts through the new
provider and establish domain identities through the existing application boundary.

## Schema and privilege boundaries

| Owner                   | Required evidence                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adea application        | Apply the checkout's migrations to an empty owned database. Verify `app.__drizzle_migrations` against the current journal and prove deterministic replay.                                                                          |
| Authentication provider | Initialize its required `user`, `session`, `account` and `verification` tables through the provider-supported tooling. Prove a second schema inspection needs no changes. Adea's application migrations must not own these tables. |
| Control Plane           | Qualify its own production migration entry point, journal, object ownership and application privileges independently. An Adea migration receipt is insufficient.                                                                   |

Use separate migration and runtime authority. Verify object ownership, runtime DML
and runtime refusal to create or alter database objects or modify migration history.
The runtime must not obtain superuser, role-creation, database-creation, replication
or row-security bypass authority. Record auth schema initialization authority
separately from the running auth service's authority.

Derive migration counts, hashes and required objects from the exact tested
checkout. Do not pin a stale migration count or use a table-name subset as the
complete schema proof. Begin with empty product and provider state; schema
initialization must not seed legacy identities or sessions.

## Disposable local acceptance

Reuse the digest-pinned PostgreSQL provisioner in
`scripts/capture-provisioning.mjs`. It owns a randomly named container, random
synthetic credentials and an ephemeral `127.0.0.1` port. Remove only that owned
container. Missing Docker, a failed migration or failed cleanup fails acceptance;
it must not become a green skipped test.

The runner must construct its database URLs from that provisioner's handle. Do not
accept an inherited `DATABASE_URL`, auth URL, remote-test allowance or CI host list
as proof of ownership. Strip inherited PostgreSQL routing, mail and provider
settings, and disable automatic environment-file loading in child processes. The
existing capture wrapper adds its provisioning URL but leaves inherited application
URLs unchanged, so the acceptance runner must establish this isolation itself.

Create uniquely named empty scratch databases. Apply production app migrations
with the generated migration URL, initialize provider tables through supported
provider tooling, and run requests against the auth service with in-memory recording
delivery. Use synthetic `example.test` addresses and passwords. Never send real
email or include passwords, URLs with credentials, cookies, reset tokens or
verification tokens in receipts.

The executable acceptance harness is a separate proposed test-only slice. Until its
paths, dependencies and implementation are approved, this plan supplies no runnable
combined acceptance command and makes no claim that the combined lifecycle passed.

## Desktop principal lifecycle

A desktop principal is a provider identity resolved to an application user. The
acceptance harness proves that resolution against a disposable PostgreSQL
instance and the real self-hosted provider, through the production composition:

| Step                                                     | Production code exercised                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A fresh account is signed up, verified and signed in     | the provider request path (`handleBetterAuthRequest`, `createBetterAuthServerAdapter`) and the recording verification delivery        |
| The provider identity is resolved to an application user | `resolveOrProvisionDesktopPrincipal` over `findUserPrincipalsByAuthIdentity` and `createUserWithAuthIdentity`                         |
| Repeated and concurrent provisioning of one identity     | the same functions, against the same database                                                                                         |
| A second fresh identity is kept separate                 | the same join                                                                                                                         |
| The desktop authorization code is issued and exchanged   | the production desktop code broker, the production session service, the production PostgreSQL stores, and the exchange request parser |
| A refresh and a logout are applied                       | the production desktop session service over the production store                                                                      |

Mock an identity mapping and the proof is worthless, so the phase must use the
production functions and the production database. Identity state belongs in the
database, not in memory. The provider subject must be the real provider user id,
and the persisted desktop credential must be a digest.

Two dependencies stay open and are recorded rather than implied:

- **The built Worker route registration.** The desktop authorize and exchange
  routes bind the framework request scope and, for the authorize route, the
  hosted provider adapter. The acceptance phase exercises the request path the
  exchange route composes; it does not prove that a built Worker registers it.
- **The joined delivery qualification.** It stays blocked until the active
  server-only delivery work merges, and the joined qualification must record the
  exact joined head it ran against. A pending head is a dependency, not a joined
  result.

## Required account lifecycle

| Case                        | Required assertions                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh signup                | Verification is required. No usable session is issued before verification; one synthetic verification delivery is recorded and the provider user is unverified.                                                |
| Verification                | Pre-verification sign-in is refused. Consuming the recorded verification link permits sign-in; persisted verification state and provider/domain identity mapping agree.                                        |
| Password reset              | A recorded reset can replace the password. A consumed reset token is refused on reuse; the old password fails and the new password succeeds. All earlier sessions are revoked.                                 |
| Logout and revocation       | Saved cookies cease to authenticate after logout and explicit revocation. Confirm persisted session deletion through fresh session reads.                                                                      |
| Origin and cache boundaries | Missing or untrusted origins are refused for state-changing requests without delivery side effects. Successful and denied auth responses carry `Cache-Control: no-store`, `Pragma: no-cache` and `Expires: 0`. |
| Desktop handoff             | Qualify the existing PKCE challenge/verifier, callback/state binding, expiry and replay refusal through the desktop authorization boundary. An email/password lifecycle does not prove PKCE.                   |

Use the installed provider's documented behavior for replay assertions. In the
#1466 candidate's Better Auth 1.6.23, already-verified email links may replay
successfully; password-reset token consumption is single-use. Do not invent a
verification-token single-use requirement or infer verified identity solely from
the verification response body.

## Connection, idle and temporary CI evidence

Loopback PostgreSQL may use the existing fixture's plaintext exception. That result
does not qualify hosted certificate verification. Separately prove strict TLS with
the effective driver configuration, refusal of verification-disabling settings,
and disabled caching for auth, sessions and permission reads. Hyperdrive and direct
connections require their own applicable evidence.

Record the configured pool limits for each process and request scope, concurrency
used, connection teardown after each response batch, settled backend counts and
idle behavior. Distinguish configuration limits from measured aggregate connection
counts. Keep retention work with its existing owner.

For temporary CI resources, prove cleanup after success, setup failure, migration
failure, test failure, timeout and cancellation. Verify removal rather than only
recording that a cleanup command ran. Cleanup errors fail the receipt; preserve
both the primary failure and teardown failure.

## Acceptance receipt

Record exact source and dependency heads, tool and PostgreSQL image versions,
fixture identity without credentials, migration/catalog replay results, each
lifecycle assertion, privilege results, connection/idle measurements, cleanup
verification and every failed or skipped check. Separate local fixture evidence
from hosted TLS, real delivery configuration and deployment acceptance.

A passing local receipt does not switch traffic, retire Neon, start the cost week
or close the remaining migration and product acceptance gates. Those decisions
require their own approved evidence and authorization.
