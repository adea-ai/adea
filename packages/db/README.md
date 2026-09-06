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

Production rollback is forward-only: deploy an application rollback while the expanded schema is
compatible, then add a reviewed corrective migration. Point-in-time restore is for data-loss
recovery, not routine schema rollback.
