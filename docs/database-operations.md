# Database environments and operations

Agent HQ uses standard PostgreSQL as its application contract. Neon supplies hosted PostgreSQL, but application and migration code must not depend on Neon management APIs.

## Environment topology

| Application target | Neon branch                       | Runtime role                 | Migration role                     |
| ------------------ | --------------------------------- | ---------------------------- | ---------------------------------- |
| Production         | `main`                            | `agent_hq_prod_app`          | `agent_hq_prod_migration`          |
| Preview/staging    | `staging`                         | `agent_hq_staging_app`       | `agent_hq_staging_migration`       |
| Development        | `development`                     | `agent_hq_dev_app`           | `agent_hq_dev_migration`           |
| Pull request CI    | `preview/pr-*` from `development` | inherited `agent_hq_dev_app` | inherited `agent_hq_dev_migration` |

Vercel stores separate `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and `DATABASE_MIGRATION_URL` records for Production, Preview, and Development. Production and Preview values are sensitive. Environment selection is deployment configuration; request data must never select a branch, connection string, or role.

`DATABASE_URL` uses the pooled Neon endpoint and the application role. `DATABASE_URL_UNPOOLED` uses the same application role for operations that cannot use transaction pooling. `DATABASE_MIGRATION_URL` is unpooled and uses the migration role. Administrative owner credentials are not stored in Vercel.

The application roles have data access granted by migrations but cannot create schemas or database objects. Migration roles own the `app` schema and can create database objects, but they are not superusers and cannot create roles, create databases, replicate, or bypass row-level security.

Neon's management API cannot return a password for a role created directly in PostgreSQL. Pull-request CI therefore stores only the rotated development role passwords in the `NEON_CI_APP_PASSWORD` and `NEON_CI_MIGRATION_PASSWORD` GitHub secrets, obtains the isolated branch hostnames from the Neon action, and constructs the URLs inside the masked job environment. It never uses the action's owner URL for database commands.

The current Neon plan does not support protected branches or IP allowlisting. Production therefore cannot yet receive Neon's deletion/reset protection or automatic child-branch password rotation. Compensating controls are separate environment roles/passwords, no owner credential in Vercel, pull-request branches rooted at `development`, TLS-only hosted URLs, and short expiry on temporary branches. Upgrade to a paid Neon plan before treating branch protection as closed.

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

The service binds only to `127.0.0.1:55432`. Override the host port with `AGENT_HQ_POSTGRES_PORT`. The credentials in `.env.example` are intentionally local-only defaults, not hosted secrets.

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
- Vercel applies the committed migration history before every web build and fails the deployment if
  the restricted migration credential is absent or a migration is not deterministic.
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
4. Update only the matching Vercel target variable.
5. Redeploy that target, verify the health probe, then rotate the next role.
6. Rotate runtime, migration, and owner credentials separately. Never log or commit a password.

Neon password resets drop active connections. Rotate during an appropriate window and rely on bounded reconnect behavior rather than long-lived sessions.
