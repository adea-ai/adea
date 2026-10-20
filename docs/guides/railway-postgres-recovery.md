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
named, required or kept. The legacy environment is retained untouched as an
accountability record, and it is not a recovery target: see
[Railway cutover checklist](railway-cutover-checklist.md).

## The tested artifact

A recovery procedure that names an untested commit is not a procedure. The
one commit this procedure names is the commit this lane proved, and nothing
else qualifies:

| Field     | Value                                                                           |
| --------- | ------------------------------------------------------------------------------- |
| Artifact  | `333b948d4c5fba1f88d98d764c075b790be6ee22` (`origin/main`)                      |
| Evidence  | `local-disposable`                                                              |
| Database  | PostgreSQL 18, the digest-pinned `postgres:18-alpine` the repository provisions |
| Proved on | a disposable loopback instance of that image, in this repository                |

What that artifact was proved to do:

- the auth schema applies to an empty schema, and a second inspection reports
  nothing pending, so the initialization is repeatable;
- the application migration journal applies and replays against the same
  checkout, and the comparison holds;
- the canonical migration and runtime roles are separated, and the runtime
  role is refused object creation;
- a schema backup restores with the same tables, columns and rows into an
  empty database, and the restored schema reports nothing pending;
- the owned disposable instance is removed on success, on failure and on
  interruption.

What that artifact was **not** proved to do, and what a live acceptance still
has to establish:

- the hosted Railway instance was not read. Its PostgreSQL version, its TLS
  mode, its pooling behaviour and its plan are unverified here;
- the hosted target carries no data yet, so no data-loss estimate exists;
- no traffic was moved and no session was issued against the hosted target.

A different commit is not qualified by this record. It needs its own proof
against the same image, and the proof must name the commit it ran against.

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
- It does not delete, drop, truncate or migrate any retained environment or
  any of its tables.
- It does not complete the wider database migration, and it does not start the
  cost measurement. The user owns the next-week follow-up.
