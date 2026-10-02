# Database environments and operations

Adea uses standard PostgreSQL as its application contract. Neon supplies hosted PostgreSQL, but application and migration code must not depend on Neon management APIs.

## Environment topology

| Target          | Neon branch                       | Runtime role                                       | Migration role                 |
| --------------- | --------------------------------- | -------------------------------------------------- | ------------------------------ |
| Production      | production                        | Dedicated role ending in `_app` (confirm its name) | `adea_prod_migration`          |
| Preview/staging | `staging`                         | `agent_hq_staging_app`                             | `agent_hq_staging_migration`   |
| Development     | `development`                     | `adea_dev_app`                                     | `adea_dev_migration`           |
| Pull request CI | `preview/pr-*` from `development` | inherited `adea_dev_app`                           | inherited `adea_dev_migration` |

The intended runtime-role contract is a role name ending in `_app`, without
schema or database `CREATE` privileges or elevated role attributes.
`scripts/database-health.mjs` checks this contract before local integration
tests; its configuration helper checks the `_app` suffix, and its database
queries check grants and role attributes. Application startup only parses the
database URL and does not enforce the suffix or privilege checks. Older
deployment notes identify `neondb_owner` as the production Hyperdrive
principal and say a dedicated `agent_hq_prod_app` role was removed. The
`neondb_owner` name does not follow the `_app` convention, but repository files
do not establish its current use or privileges. Confirm production
configuration through the approved operations process before claiming it
passes the intended contract; this guide does not verify live credentials.

The deployment setup expects Cloudflare Secret Store records for hosted
`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and `DATABASE_MIGRATION_URL` in
Production, Preview, and Development. The production migration workflow reads
`DATABASE_MIGRATION_URL` from GitHub Secrets. This guide records the intended
configuration; it does not verify whether a secret is configured or inspect
its value. Production and Preview values are sensitive. Environment selection
belongs to deployment configuration; request data must never select a branch,
connection string, or role.

By contract, `DATABASE_URL` uses the pooled Neon endpoint and the runtime
`_app` role. `DATABASE_URL_UNPOOLED` uses the same role for operations that
cannot use transaction pooling. `DATABASE_MIGRATION_URL` is unpooled and uses
the migration role. Keep administrative owner credentials out of Worker
application secrets.

The intended application-role privileges allow data access granted by
migrations but not schema or database object creation. Migration roles own the
`app` schema and can create database objects, but are not superusers and cannot
create roles, create databases, replicate, or bypass row-level security.

Neon's management API cannot return a password for a role created directly in PostgreSQL. Pull-request CI therefore stores only the rotated development role passwords in the `NEON_CI_APP_PASSWORD` and `NEON_CI_MIGRATION_PASSWORD` GitHub secrets, obtains the isolated branch hostnames from the Neon action, and constructs the URLs inside the masked job environment. It never uses the action's owner URL for database commands.

The previous operations record reported that the Neon plan lacked protected
branches and IP allowlisting. That account-specific status has not been checked
in this documentation pass. Confirm the plan and project settings before
relying on that limitation or claiming those protections are enabled. The
recorded compensating controls were separate environment roles and passwords,
no owner credential in Worker application secrets, pull-request branches rooted
at `development`, TLS-only hosted URLs, and short expiry for temporary
branches. Recheck these controls before treating branch protection as closed.

## Local PostgreSQL

The local container matches the hosted PostgreSQL major version and creates the same application/migration privilege boundary.

```sh
docker compose up -d postgres
cp apps/web/.env.example apps/web/.env.local
set -a
source apps/web/.env.local
set +a
node scripts/database-health.mjs
```

The service binds only to `127.0.0.1:55432`. Override the host port with `ADEA_POSTGRES_PORT`. The credentials in `.env.example` are intentionally local-only defaults, not hosted secrets.

`bun run test:integration` uses this local service automatically when no
`DATABASE_URL` is exported. It starts PostgreSQL when necessary, verifies the
runtime and migration role boundary, applies the migration history twice, and
runs every integration case. To run against Neon instead, export the three
canonical URLs for an isolated development/preview branch; never point the
write-heavy suite at a production or owner connection.

## Health and configuration validation

Run the health probe from an environment that has `psql` and the three canonical variables:

```sh
node scripts/database-health.mjs
```

It fails when credentials are client-prefixed, hosted TLS is disabled, environments differ, runtime and migration roles are shared, Neon pooling is misconfigured, or the connected roles exceed their expected DDL boundary. It never prints connection strings, hosts, or passwords.

## Migrations

- Generate migrations from reviewed Drizzle schemas in `@agent-hq/db`.
- Review committed SQL before applying it.
- Run migrations with `DATABASE_MIGRATION_URL`; ordinary requests use `DATABASE_URL`.
- Apply migrations once per deployment before application traffic depends on them.
- The production migration workflow runs on pushes to `main` that change
  `packages/db/drizzle/**`, the migration verifier, or that workflow, and it can
  also be started manually. It runs separately from the Worker deployment, so
  it does not gate or fail that deployment. The workflow runs `db:verify` and
  fails if the migration credential is missing or verification fails.
- Keep schema changes backward-compatible and deploy them before code that
  depends on them. Confirm the migration workflow has completed before relying
  on a newly added schema object.
- Never edit an applied migration. Add a forward fix.
- Prefer expand/migrate/contract changes. Roll back application code independently while the expanded schema remains compatible.
- Use point-in-time restore only for data-loss recovery, not as the normal schema rollback mechanism.
- Pull-request CI applies the full migration history twice and compares the Drizzle journal before running transaction integration tests on its isolated Neon branch.

## Backup and restore

Neon retains branch history according to the project restore window. The current free-plan project reports a six-hour window. A restore drill must use a disposable child of `development`, never `main`:

1. Create an expiring `ops/restore-drill-*` branch from `development`.
2. Write a baseline marker and record a PostgreSQL UTC timestamp after commit.
3. Write a second marker.
4. Restore the disposable branch from `^self@<timestamp>` and preserve its pre-restore state under another disposable branch name.
5. Verify the restored branch contains only the baseline and the preserved branch contains both markers.
6. Delete the restored target first, then its preserved parent. Expiry on the target is the fallback cleanup.

Record the date, branch IDs, counts, and operator in the pull request or operations log. Run this drill after changing the retention policy and at least quarterly.

### Restore drill record

The non-production restore drill completed on 2026-08-24 at `00:04:47Z`:

- target: `ops/restore-drill-20260824000431` (`br-solitary-hall-auwa116c`)
- preserved state: `ops/restore-drill-20260824000431-preserved` (`br-royal-lab-aulgoyt6`)
- before restore: two markers
- restored target: one baseline marker
- preserved branch: two markers
- restored target after verification: zero later markers
- operator: `0xPlayerOne/Codex`
- cleanup: both disposable branches deleted and absence verified

Neon may create the preserved state without an active compute. Attach a temporary read-only compute before querying it. A preserved branch cannot expire while it is the parent of the restored target, which is why cleanup order matters.

## Credential rotation

1. Generate a distinct random password for exactly one environment and role.
2. Change the PostgreSQL role password through an owner-only administrative connection.
3. Verify a new connection succeeds and the previous password fails.
4. Update only the matching Secret Store secret (or the GitHub secret for CI-only values).
5. Redeploy that target, verify the health probe, then rotate the next role.
6. Rotate runtime, migration, and owner credentials separately. Never log or commit a password.

Neon password resets drop active connections. Rotate during an appropriate window and rely on bounded reconnect behavior rather than long-lived sessions.
