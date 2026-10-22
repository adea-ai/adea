# Database environments and operations

Adea uses PostgreSQL hosted on Railway production. The verified database service, schema ownership, transport endpoints, certificate peer identity, and CA fingerprint are recorded in [Railway production readiness](evidence/railway-production-readiness.md).

## Environment topology

| Target                    | Database                            | Identity                                     |
| ------------------------- | ----------------------------------- | -------------------------------------------- |
| Production application    | `railway`, `app` schema             | Dedicated runtime role with DML, no DDL      |
| Production authentication | `railway`, `auth` schema            | Dedicated auth runtime role with DML, no DDL |
| Production migrations     | `railway`, `app` and `auth` schemas | `adea_prod_migration`                        |
| Local and CI tests        | Disposable sandbox PostgreSQL       | Synthetic independent roles and credentials  |

Production is the only persistent Railway environment. Never supply production credentials to test runners. Request data cannot select a database, schema owner, or connection URL.

## Role separation

The migration role owns only `app` and `auth`. It has no superuser, CREATEDB, CREATEROLE, replication, BYPASSRLS, inherited role memberships, or database-wide CREATE. PUBLIC has no privileges on the application schemas.

Runtime roles receive only required schema usage, table DML, sequence access, and function execution. They cannot create schema objects or inherit migration/admin roles. Administrative credentials are used only for approved provisioning and never serve application requests or migrations.

## Strict TLS

The external migration route is `altaria.proxy.rlwy.net:44407`; its authenticated PostgreSQL peer identity is `postgres.railway.internal`. The certificate does not identify the public proxy hostname. The migration client validates both identities separately and loads the reviewed public CA from `.railway/production-postgres-ca.crt`.

`packages/db/src/migration-target.ts` pins the database, role, endpoint, port, peer name, and DER CA fingerprint. Production `DATABASE_MIGRATION_URL` requires `sslmode=verify-full` and accepts no endpoint or TLS overrides. The driver receives explicit `{ca, servername, rejectUnauthorized: true}`. A TLS URL alone is insufficient evidence of the driver's effective verification policy.

## Migration workflow

1. Review the exact source head and additive SQL migrations.
2. Verify target identity, schema ownership, CA fingerprint, effective TLS, and runtime grants.
3. Run `bun run --cwd packages/db db:verify` with `DATABASE_MIGRATION_URL` from supported secure storage. It checks canonical migration history before applying and compares history after a deterministic rerun.
4. Initialize Better Auth through its separate operator command: plan first, then `bun run --cwd packages/auth schema-init -- --apply` with a migration URL whose single-schema search path is `auth`.
5. Verify runtime capabilities and schema readiness before application traffic uses new objects.

The production GitHub workflow reads only `adea-ai/adea` → `DATABASE_MIGRATION_URL`. Credentials must not enter repository files, command arguments, logs, receipts, or chat. The public CA certificate contains no private key or credential.

## Runtime routing and freshness

The Worker uses Cloudflare Hyperdrive for application queries. Verify its exact origin, database, runtime role, TLS policy, and cache-disabled setting by provider readback. Authentication, session, and permission reads must observe current authority. ORM cache configuration does not establish Hyperdrive's query-cache setting.

The auth service reads separate runtime configuration: `AUTH_BASE_URL`, `AUTH_SECRET`, `AUTH_DATABASE_URL`, and `AUTH_TRUSTED_ORIGINS`. Verification and reset delivery must be configured; keep verification enabled. Secrets Store bindings resolve lazily, so a successful build or deployment does not prove a binding resolves or login works.

## Backup and recovery

Use Railway-supported backup/restore or a reviewed forward migration. Preserve exact source and schema compatibility evidence before a restore. Routine application rollback does not reverse applied SQL. A disposable restore rehearsal uses synthetic data and independent credentials.

## Acceptance

[Fresh PostgreSQL acceptance](guides/fresh-postgres-acceptance.md) covers synthetic account lifecycle and test cleanup. Production acceptance separately verifies effective bindings, strict TLS, least privilege, private runtime connectivity, schema readiness, verification/reset delivery, web/desktop PKCE, origin and CSRF refusal, refresh, logout, and revocation.

The [cutover checklist](guides/railway-cutover-checklist.md) records deployment ordering. A liveness response does not prove database readiness or login acceptance. Start [cost observation](guides/railway-cost-week-plan.md) only after the verified cutover.
