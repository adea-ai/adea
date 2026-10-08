# Database package

`/db` is Adea's server-only PostgreSQL boundary. Its public entry point imports
`server-only`, and no database subpaths are exported. Browser, mobile, and desktop code must use
API contracts from `/api-client` and cache/query behavior from `/data`.

## Schema conventions

- Organize schemas by domain (`workspaces.ts`, `events.ts`), not one file per table.
- Use UUID primary keys, `timestamptz`, snake_case SQL names, camelCase TypeScript names, and
  typed JSONB payloads.
- Model lifecycle state with PostgreSQL enums and database constraints. `deleted_at` is reserved
  for domains whose retention rules require soft deletion.
- Put foreign keys, uniqueness, checks, and query-path indexes in the Drizzle schema so they are
  represented in reviewed SQL migrations.

## Connections and transactions

Create one connection per server process with `createDatabase()`, reuse it, and close it during
graceful shutdown. Runtime code uses `DATABASE_URL`; migration commands require the unpooled
`DATABASE_MIGRATION_URL`.

Use `inTransaction()` for a domain mutation that must atomically append a `WorkspaceEvent` or an
outbox/inbox record. Pass the transaction object through repository helpers; never fall back to a
process-global connection inside a transaction.

`createUserWithAuthIdentity()` creates the stable `User` and provider identity in one transaction.
Resolve sessions with `findUserPrincipalsByAuthIdentity()` and pass only the returned user
`PrincipalRef` into authorization code. Provider subjects are authentication keys, never domain
user IDs or workspace foreign keys.

## Migration workflow

1. Change the domain schema and add or update tests.
2. Run `bun run --cwd packages/db db:generate -- --name=<short-name>`.
3. Review the generated SQL and snapshot. Never edit a migration after it has been applied.
4. Run `bun run --cwd packages/db db:check`.
5. Against an isolated database, run `bun run --cwd packages/db db:verify` and
   `bun run --cwd packages/db test:integration`.

The root and package integration runners build the public `remote-content`
and `types/runtime-node-delivery` entries before running the database producer tests, so a fresh checkout needs no
previous workspace build.

Outbound pulls retain the original submission actor, nonce/rate records and
current authorization locks before releasing ciphertext. Migrations 0037/0038
add those records and a distinct runtime-node event actor. Unrecoverable legacy
authority remains withheld. Pull is not execution acceptance or a host receipt.

Migration 0039 is the [relay retention expansion phase](../../docs/evidence/m11-relay-retention-schema.md).
It adds a nullable purge marker, partial expiry index and expiry constraint before
the matching application declaration/operator deploys. This application phase
aligns the runtime declaration with that expanded snapshot; integrate both phases
before generating further migrations.

The [retention operator](../../docs/guides/relay-ciphertext-retention.md)
uses an explicit workspace and direct application-role connection, defaults to
dry-run, and preserves submission identity and execution/history state. Verify
the approved target's schema readiness before deploying code that reads the
column; parallel main-push migration and Worker jobs do not establish order.
Nothing runs cleanup automatically.

Production rollback is forward-only: deploy an application rollback while the expanded schema is
compatible, then add a reviewed corrective migration. Point-in-time restore is for data-loss
recovery, not routine schema rollback.

Workspace migrations 0040/0041 are the [workspace schema expansion phase](../../docs/evidence/workspace-schema-expansion.md). They precede application use of personal identity/deletion metadata. Their snapshots preserve retention0039's expansion; runtime declarations remain staged ahead of activation. Do not generate migrations from an older declaration that would remove these columns or constraints. Verify production migration history/catalog before landing the matching application.

Migration 0042 adds the [workspace lead and direct-topic foundations](../../docs/evidence/pi-durable-foundations.md).
It preserves the staged 0041 schema and all legacy identities, history and audiences.
Apply it before the new lead/topic API callers; a designation or canonical message
is not model readiness or execution acceptance.
