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
the matching application declaration/operator deploys. During this short staged
rollout the generated snapshot is ahead of the runtime declaration: integrate
the application phase before generating further migrations from that declaration.
Verify the approved target's schema readiness before publishing code that reads
the column; parallel main-push migration and Worker jobs do not establish order.

Production rollback is forward-only: deploy an application rollback while the expanded schema is
compatible, then add a reviewed corrective migration. Point-in-time restore is for data-loss
recovery, not routine schema rollback.

Workspace migrations 0040/0041 are the [workspace schema expansion phase](../../docs/evidence/workspace-schema-expansion.md). They precede application use of personal identity/deletion metadata. Their snapshots preserve retention0039's expansion. Do not generate migrations from an older declaration that would remove these columns or constraints. Verify production migration history/catalog before landing the matching application.

## Permanent workspace deletion

Active permanent deletion is unavailable until server-owned cleanup completion
can be verified. `deleteWorkspace()` is owner-only and checks the current workspace
name and version inside its transaction before refusing completion. Dormant
final-deletion logic would remove memberships and authorization audit
rows explicitly; root foreign-key cascades would prune workspace-owned data, encrypted
replicas, events/outbox records, runtime node registrations and their credentials.
A minimal `workspace_deletions` receipt keeps owner/id/creation-key/deletion time
for safe retries and to prevent old creation keys from being
recreated. Creation, bootstrap, deletion and guest claim transfers serialize on
the owner row. Both guest claim paths transfer deletion receipts to the target
account. The persistent personal workspace cannot be deleted or archived, including via a direct helper or retry; active additional-workspace deletion is blocked pending server-verifiable cleanup completion.

Active-workspace deletion is currently unavailable. Both `beginWorkspaceDeletion`
and `deleteWorkspace` require a server-owned cleanup-completion verifier, which
has not been implemented, and fail closed with `workspace_deletion_cleanup_required`.
No caller boolean, trusted desktop header, owner credential or
`deletion_requested_at` timestamp proves local cleanup completion. New preparation
does not create pending intent. Existing interrupted intent remains visible and
frozen; retries retain the cloud root and local data. Receipt retries are accepted
only when the cloud root is actually absent. Cascade tests use explicit disposable
raw SQL fixtures, not a production authorization bypass.

`control_plane_used_at` conservatively backfills existing workspace scopes.
Mutating Control Plane credentials record external ownership before token issuance,
conditional on no pending deletion. Used/unverified scopes, registered runtime
nodes and queued/running/review tasks remain additional refusal reasons. Shared
host authentication/state is retained. Native recovery cleanup can resume only
from fresh owner proof that a historical cloud root is already deleted; a
`cleanup_pending` response never authorizes archival, local purge or identity
removal. No universal physical purge is claimed.

## Personal workspace bootstrap

`ensureBootstrapWorkspaces()` gives every signed-in user and guest one personal
root, initially Home with a home icon and the established app defaults. The
immutable settings boundary never accepts `isPersonal`. A partial owner unique
index and active-root constraint prevent duplicate personal identities or
archive/pending states. Additional creation produces a box icon and empty data,
appends to the member's list, and never seeds accounts, projects or agents.
All memberships, including Home, remain reorderable; bootstrap's default is the
personal identity rather than list position.

The production API regression uses the `react-server` condition to exercise its
`server-only` database entry; both supported integration runners build that entry
before executing the tests. Workspace migrations 0040/0041 preserve the 0039
retention expansion in their snapshots without activating its runtime declaration.

Migration 0041 recognizes only stable `default-home`/`default` creation metadata;
it preserves customizations and content and restores a proven archived root.
Legacy Work remains. Historical `claimed:<id>` metadata cannot prove which
workspace was originally personal: bootstrap retains all of them and creates a
separate Home once. Guest-to-new-account claims retain their root; existing
account claims keep the account root and preserve the guest workspace as an
additional workspace. Application bootstrap and both claims serialize owner
identity decisions. No migration or onboarding operation connects an account.

`reorderWorkspaces()` locks the member's user row, requires the complete live list
with no duplicates or foreign IDs, and updates only that member's positions. It
shares the creation/claim lock, and neither modifies workspace versions nor
changes another user's membership order.
