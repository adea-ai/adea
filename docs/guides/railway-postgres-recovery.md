# Railway PostgreSQL recovery

This procedure recovers the Railway-managed PostgreSQL that hosts the Adea
authentication schema. It authorizes nothing. It provisions nothing, it reads
no live instance, and it changes no credential, binding or deployed artifact.
Every step that touches the live target is a root-owned operation, and the
steps below name which ones those are.

## What recovery is

Recovery is one of two things, and nothing else:

| Method                   | What it does                                                               | What it needs                                                                 |
| ------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `forward-fix`            | a defect is fixed forward and the fix is proved on a disposable instance   | a reviewed branch and a disposable proof of the same PostgreSQL major version |
| `railway-backup-restore` | a backup of the target schema is restored into a fresh schema and compared | a backup taken from the target, taken and restored by root                    |

There is no third method. An earlier artifact is not a recovery method here,
so no legacy artifact, no fallback provider and no compatibility path is
named, required or kept. The repository's historical records of the legacy
environment are kept as non-operational evidence; nothing here reads,
restores or depends on a running legacy environment, and it is not a recovery
target: see [Railway cutover checklist](railway-cutover-checklist.md).

## The proved artifact

A recovery procedure that names an untested commit is not a procedure. The
one commit this procedure names is the commit a proof receipt names, and
nothing else qualifies:

The artifact of record is not a name in this document. It is the artifact a
proof receipt names, and a receipt only names one when it is a **passed, real
database proof**:

| Field     | Where it comes from                                                             |
| --------- | ------------------------------------------------------------------------------- |
| Artifact  | `checkout.sha` of the proof receipt, the exact commit the proof ran in          |
| Source    | `checkout.source` of the proof receipt, the ref the proof was made from         |
| Clean     | `checkout.dirty` of the proof receipt, which is `false` in a usable one         |
| Module    | `module.sha` of the proof receipt, the tree the proof code came from            |
| Evidence  | the `evidence` class of the proof receipt, never `simulated`                    |
| Kind      | the `proofKind` of the proof receipt, a database proof and nothing else         |
| Observed  | the result fields the proof recorded, such as the migration count               |
| Database  | PostgreSQL 18, the digest-pinned `postgres:18-alpine` the repository provisions |
| Proved on | a disposable loopback instance of that image, in this repository                |

A receipt is refused when it failed, when it is not a database proof, when its
evidence is `simulated`, when it does not carry the result it claims to have
observed, when it carries no provenance, when it was produced from a tree with
uncommitted changes, or when the tree it exercised is not the tree the code
came from. A commit that is written into a document instead of read from a
receipt is not reproducible, because nobody can show what ran.

The guarantees below are the ones the receipt's own kind of proof supports. A
guarantee is never stamped on a run that did not produce it: the fresh-account
acceptance lane does not claim the backup and restore proof, and the disposable
proof does not claim the provider lifecycle.

The instances this procedure was written against are recorded here as history,
not as a standing artifact:

- `333b948d4c5fba1f88d98d764c075b790be6ee22` (`origin/main`), proved locally on
  2026-10-20 with the disposable CI proof and the fresh-account acceptance
  lane;
- the pull request head that carries this procedure, proved locally on the same
  day with the same two lanes.

What the two kinds of proof showed:

The **fresh-account acceptance lane** (`fresh-schema-acceptance`):

- the auth schema applies to an empty schema, and a second inspection reports
  nothing pending, so the initialization is repeatable;
- the application migration journal applies and replays against the same
  checkout, and the comparison holds;
- the provider lifecycle and the desktop principal journey ran against the real
  database, and the receipt carries the measured counts.

The **disposable PostgreSQL proof** (`disposable-postgres-proof`):

- the auth schema applies to an empty schema and replays as a no-op;
- the application migration journal applies and replays against the same
  checkout;
- the canonical migration and runtime roles are separated, and the runtime
  role is refused object creation;
- a schema backup restores with the same tables, columns and rows into an
  empty database, and the restored schema reports nothing pending;
- the owned disposable instance is removed on success, on failure and on
  interruption.

The **built-Worker desktop authorization qualification**
(`built-worker-desktop-auth`):

- the production-built Worker served the desktop authorize and exchange routes
  against a disposable loopback instance, and both routes answered;
- the authorize route refused a caller without a session, refused a request that
  carried a parameter the desktop contract does not define, and issued an
  authorization code to a fresh account the Worker signed up itself;
- the exchange route turned that code into a desktop session, and refused a wrong
  PKCE verifier, an untrusted origin and a replayed code;
- the exchange preflight refused an untrusted origin;
- no response carried the auth secret, the session cookie, the authorization
  code or the desktop credential;
- the receipt carries every assertion by name, the number of assertions that
  passed, how many attempts each assertion made, how every attempt ended, the
  identity of the built artifact the qualification proved, the verdict of the
  teardown, and the full auth lifecycle assertions the lane proved against the
  same instance;
- an authorization is validated before it is exchanged: the redirect must be a
  `303` to the desktop completion page, and its callback must be exactly the
  desktop callback with exactly the code, nonce and state the client sent;
- a failure is published with one of a fixed set of kinds and a redacted
  detail, and the runtime's own output is redacted before it is quoted;
- every field of the stored receipt and of the published receipt is sanitized
  before it is published, so a value that reached a detail, a URL or a name a
  suite reported cannot travel out with the evidence;
- an application failure is never retried into a pass, and a request whose
  outcome is unknown is never replayed;
- the Worker is stopped and its process group confirmed gone before the runtime
  material and the container are removed, and the material is kept when the
  process is still alive;
- the receipt is published only after that teardown succeeded, and the Worker
  and the disposable instance are removed on success, on failure and on
  interruption.

What a proved artifact was **not** shown to do, and what a live acceptance
still has to establish:

- the hosted Railway instance was not read. Its PostgreSQL version, its TLS
  mode, its pooling behaviour and its plan are unverified here;
- the hosted target's data state is **UNKNOWN**. The live target was not read,
  so no data-loss estimate is available, and an unobserved state is not an
  empty one;
- no traffic was moved and no session was issued against the hosted target;
- the built Worker ran on the local development runtime, not on the hosted
  Cloudflare runtime. The hosted runtime's own connections, its pooler binding
  and its certificate handling were not exercised, and the local qualification
  reaches the disposable instance with the repository's loopback development
  policy rather than with the hosted lane's verified TLS connection.

A different commit is not qualified by any of this. It needs its own proof
against the same image, and that proof must carry its own provenance.

## Evidence classes

Not every acceptance result is worth the same. A receipt carries the class of
its own evidence, and the class is refused when it is stronger than the source
that produced it.

| Class              | What it proves                                                             | What it does not prove                        |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------- |
| `simulated`        | the runner's gates, against a synthetic child or an in-memory journey      | anything about PostgreSQL                     |
| `local-disposable` | the real provider and the real database, on a disposable loopback instance | the hosted target, CI, or a deployed artifact |
| `ci`               | the same disposable lane inside the repository's CI                        | the hosted target                             |
| `live`             | the hosted Railway target, against an authorized live run                  | anything it was not authorized to test        |

The `live` class is refused until a live acceptance is authorized. Live
acceptance is root-owned and stays open until it is separately authorized and
verified.

## Forward-fix

1. Record the exact failing statement, the exact head that produced it and the
   exact disposable instance it was reproduced on.
2. Fix it forward on a branch. Do not resurrect an earlier artifact and do not
   restore an old binding set: the current artifact fails closed without the
   new binding set, and that is the intended behaviour.
3. Prove the fix on a disposable instance of the same PostgreSQL major
   version: the schema initializer in plan mode, then apply, then a second
   inspection that reports nothing pending, then the migration checks.
4. Read the plan output before any apply. The plan reads only the
   migration-role URL; the runtime URL is never consulted.
5. Apply with the schema-owning migration role, on the target. The apply is
   all-or-nothing in one transaction on one connection, so a failure rolls the
   whole apply back.
6. Inspect again and require nothing pending.

Steps 5 and 6 are live operations on the Railway target. They are root-owned,
and this procedure does not perform them.

## Railway backup and restore

1. Take a backup of the target schema with the PostgreSQL 18 client tools, and
   keep it with the receipt. The backup names the target, the schema and the
   moment it was taken.
2. Restore that backup into an empty schema on a disposable instance and
   compare the tables, the columns and the rows. The comparison is the proof
   that the backup is usable; a backup that was never restored is not one.
3. Restore the backup into a fresh schema on the target with the
   schema-owning migration role.
4. Compare the restored schema against the backup before any traffic is
   pointed at it. The runtime role must still be refused object creation, and
   the restored schema must report nothing pending.
5. Leave the previous schema in place until the restored one is accepted. The
   procedure does not drop, truncate or alter the previous schema, and a
   second attempt does not need a new instance.

Steps 1, 3, 4 and 5 are live operations on the Railway target. They are
root-owned, and this procedure does not perform them.

## The Control Plane compatibility scope

The application, the authentication provider and the Control Plane own
separate migration boundaries. This procedure qualifies the auth schema only.

| Item                                  | Owner         | Qualified by            | State                                         |
| ------------------------------------- | ------------- | ----------------------- | --------------------------------------------- |
| `adea-application-migrations`         | Adea          | an Adea receipt         | proved on the disposable instance             |
| `adea-canonical-privileges`           | Adea          | an Adea receipt         | proved on the disposable instance             |
| `adea-array-type-registration`        | Adea          | an Adea receipt         | proved by the merged array registration proof |
| `cp-production-migration-entry-point` | Control Plane | a Control Plane receipt | open                                          |
| `cp-migration-journal`                | Control Plane | a Control Plane receipt | open                                          |
| `cp-object-ownership`                 | Control Plane | a Control Plane receipt | open                                          |
| `cp-application-privileges`           | Control Plane | a Control Plane receipt | open                                          |

The four Control Plane items stay open. They need the Control Plane's own
production migration entry point, journal, object ownership and privilege
evidence, in the Control Plane's own repository. An Adea receipt cannot stand
in for them, and this lane does not attempt to produce them. The scope record
lives in `scripts/fresh-postgres-acceptance/cp-compatibility.mjs`, and its
guard refuses to record a Control Plane item as qualified by an Adea receipt.

## The fresh-account rule

The recovery target holds synthetic fresh accounts only. The acceptance scope
carries no legacy identity import, no row copy out of another table, no second
write target and no database target outside the loopback interface. The rule
is enforced by `scripts/fresh-postgres-acceptance/fresh-account-only.mjs`,
and its own regressions prove that every construct it claims to catch is
caught.

## What this procedure does not do

- It does not qualify the hosted target. The live acceptance is open until it
  is separately authorized and verified.
- It does not move traffic, deploy an artifact, change a binding or rotate a
  credential.
- It does not name, require or keep a legacy artifact, a fallback provider or
  a compatibility path.
- It does not require a legacy environment to exist or to stay running. The
  repository's historical records of the legacy environment are kept as
  evidence, and nothing here reads, restores or depends on a running one.
- It does not complete the wider database migration, and it does not start the
  cost measurement. The user owns the next-week follow-up.
