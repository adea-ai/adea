# Lane H — Neon dependency audit and live measurement

**Date:** 2026-10-20 · **Lane:** H — efficiency and no-Neon dependency audit
**Scope:** the whole repository (runtime, dependencies, generated configuration, tests, docs, CI,
scripts, environment requirements) plus a read-only measurement of the deployed Cloudflare Worker
and the reachable Railway project.

This page is the audit and its evidence. The measurements it cites are in
[the measurement file](lane-h-cloudflare-railway-measurement-2026-10-20.json). The source removals
this lane owns are in the same commit as this page.

## What this audit establishes

1. **Every remaining reference to the retired provider is classified.** Nothing in the repository is
   left unclassified, and each class has an owner and a next action.
2. **This pull request removes the application's runtime, deployment configuration and local
   environment references to that provider.** The runtime has no provider-shaped branch left, and the
   deployment configuration binds only the managed database and the self-hosted auth service. These
   removals land with this pull request's own merge; `main` still carries them until then (see §10).
3. **The live production Worker still does.** That is a production fact, not a repository fact, and
   it is in [the production operations section](#9-production-operations-needing-root-approval) below
   with the exact steps. Root read the same three facts directly at about 08:00–08:02 UTC on
   2026-10-20: the legacy bindings remain, the edge pooler's origin is still the provider's, and
   its query cache is enabled. **The live migration is not complete**, and no production mutation is
   authorized.
4. **The remaining references are in other owners' lanes.** They are listed with the owner and the
   scoped action, so each owner can take its own change without this lane editing its files.
5. **The Cloudflare CPU, request, error and subrequest series is now readable.** The
   [Railway cost week plan](../guides/railway-cost-week-plan.md) recorded that the live read was
   blocked on the route that was tried. It is not blocked any more: the Cloudflare GraphQL
   Analytics API answers for this account through the already-authorized `cf` CLI credential. That
   credential has since expired, so the series cannot be refreshed without a credential decision
   that is not this lane's to make.

## How the classes are defined

| Class                                | Meaning                                                                                                                                     | Rule                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Active integration**               | The repository's runtime, configuration, dependencies or local environment reach the provider, or a provider-shaped rule decides behaviour. | Removed, or routed to the single owner of that file.                                          |
| **Live production state**            | The deployed Worker, its bindings or its pooler still point at the provider.                                                                | Not a repository change. Reported for root, with the exact steps.                             |
| **Historical accountability record** | A record of what the deployment used to be, or of a decision already taken.                                                                 | Retained. It must not carry an active dependency.                                             |
| **Naming only**                      | A string in a test fixture, a deny rule, or a comment that names the provider without reaching it.                                          | Kept where removing it would weaken a gate or lose a regression's meaning; otherwise renamed. |

## 1. Active integrations removed by this lane

| Area              | File                                                       | What was removed                                                                                                         | What replaces it                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | `packages/db/src/config.ts`                                | `isTransactionPooledHost` and the `-pooler.`/`.neon.tech` host heuristic that decided the statement mode.                | Every connection prepares statements. A host name is not a statement-capability contract.                                                                                                                                                                                                                           |
| Runtime           | `packages/db/src/connection.ts`                            | The connection-role branch behind `prepare`.                                                                             | `prepare` defaults to true; only a declared transaction-pooled origin may turn it off.                                                                                                                                                                                                                              |
| Scripts           | `scripts/database-config.mjs`                              | The pooled/unpooled endpoint rules and the "same environment" hostname normalisation.                                    | Runtime, migration and unpooled connections must reach one PostgreSQL instance, identified exactly by its host, its port and its database name. No host name is rewritten and no lookalike is forgiven. This lands with this pull request's own merge; `main` still carries the normalisation until then (see §10). |
| Generated config  | `apps/web/wrangler.jsonc`, `apps/web/cloudflare.config.ts` | The `DATABASE_URL`/`NEON_AUTH_BASE_URL`/`NEON_AUTH_COOKIE_SECRET` bindings and the store name that carried the provider. | `DATABASE_URL`, `AUTH_BASE_URL`, `AUTH_SECRET`, `AUTH_DATABASE_URL` bound to the Railway-managed records.                                                                                                                                                                                                           |
| Runtime           | `apps/web/src/server/event-cursor.ts`                      | The cursor's signing key read from `NEON_AUTH_COOKIE_SECRET`.                                                            | `AUTH_SECRET`, the one secret the deployment rotates.                                                                                                                                                                                                                                                               |
| Browser boundary  | `apps/web/start/client-policy.mjs`                         | Nothing is removed from the private-environment list.                                                                    | The legacy secret names stay denied while the auth lane's legacy reader, driver and client SDK dependency are still in the tree; `AUTH_SECRET`, `AUTH_DATABASE_URL` and `AUTH_BASE_URL` are added. `AUTH_BASE_URL` is server-only too, which the cutover checklist had flagged as unreviewed.                       |
| App code          | `apps/web/src/**`, `apps/web/start/**`                     | The provider-named adapter calls and comments.                                                                           | The provider-neutral aliases `createAuthServerAdapter`, `handleAuthRequest` and `createAuthClientAdapter`, which `@adea-ai/auth` already exported.                                                                                                                                                                  |
| Local environment | `apps/web/.env.example`, `apps/web/.dev.vars.example`      | The provider's local auth names and the instruction to read them from a provider CLI.                                    | The self-hosted auth service's own names.                                                                                                                                                                                                                                                                           |

The provider's own client-bundle deny rules stay: `apps/web/start/client-policy.mjs` and
`apps/web/test/start-client-denylist.json` still refuse `@neondatabase/auth` in the browser graph,
and `scripts/auth-boundary.test.ts` still refuses it outside `@adea-ai/auth`. Those are gates, and
the dependency they guard is still installed. Removing them before the dependency goes would
weaken a gate.

## 2. Live production state (root-owned)

The deployed Worker is version 1343, uploaded 2026-10-20T06:35:30Z. Its bindings are read in the
measurement file. Three of them are provider-named, and the pooler in front of the database still
points at the provider:

| Live object                              | Current value                                                                                                                                          | Consequence                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Worker binding `DATABASE_URL`            | store record `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL`                                                                                                   | The application fallback URL is the provider's.                                       |
| Worker binding `NEON_AUTH_BASE_URL`      | store record `AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL`                                                                                                  | The legacy provider's auth endpoint.                                                  |
| Worker binding `NEON_AUTH_COOKIE_SECRET` | store record `AGENT_HQ_WORKER_AUTH_COOKIE_SECRET`                                                                                                      | The legacy provider's cookie secret.                                                  |
| Hyperdrive `adea-db`                     | origin `ep-aged-king-a52genig.us-east-2.aws.neon.tech:5432`, database `neondb`, user `neondb_owner`, origin connection limit 20, query caching enabled | Every Worker database connection still reaches the provider, through the edge pooler. |

**The production auth endpoint is failing.** `GET https://adea.dev/api/auth/get-session` answered
**HTTP 500** with `{"status":500,"unhandled":true,"message":"HTTPError"}` at 2026-10-20T07:21Z. The
root document answered 200. The cause is the binding set above: the deployed Worker binds the
legacy provider's auth names and does **not** bind `AUTH_BASE_URL`, `AUTH_SECRET` or
`AUTH_DATABASE_URL`, which the self-hosted auth service requires. `readBetterAuthConfig` throws
`AUTH_BASE_URL is required`, so the service cannot be constructed. The account path in
`apps/web/src/server/workspace-principal.ts` catches that failure and treats the visitor as a guest,
so the failure is silent on the signed-in path; the `/api/auth/*` route does not catch it and returns 500.

This is the state this lane's source change is designed to end, and it is a production operation to
end it. See [the operations list](#9-production-operations-needing-root-approval).

### Root's independent live observation

Root read the Cloudflare settings directly on 2026-10-20 at about 08:00–08:02 UTC and found the same
three facts this lane's 07:30Z read recorded:

- the live Worker still carries the legacy auth bindings;
- the Hyperdrive origin is still the provider's host;
- `caching.disabled` is `false`, so the edge pooler's query cache is **on**.

This lane's own re-read of the same settings was attempted afterwards and is **blocked**: the
`cf` CLI credential expired at 2026-10-20T08:10:48Z and the API answers HTTP 403 for it. This lane
did not refresh or re-authorize it, because refreshing a credential is not this lane's to decide.
Root's observation is therefore the later reading, and it is recorded as root's.

**No production mutation is authorized, and the live migration is not complete.** The live Worker
still reaches the provider through the edge pooler, and the three legacy bindings are still
attached. Nothing in this pull request changes that; the pull request changes what the repository
deploys, once root runs the operations below.

## 3. Active integrations owned by another lane

Each row is a scoped finding. The implementation belongs to that lane's owner; this lane does not
edit those files.

### 3a. Auth lane (B)

| File                                                                                       | Active coupling                                                                                                                                                                           | Scoped action                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/config.ts`                                                              | `readAuthConfig` reads `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET`. The function is exported and has no production caller.                                                         | Remove the legacy reader and the two names. The deployment no longer binds them.                                 |
| `packages/auth/src/neon-driver.ts`                                                         | The legacy provider driver, exported and unused at runtime.                                                                                                                               | Remove with the reader.                                                                                          |
| `packages/auth/src/session.ts`                                                             | `normalizeNeonSession` and the `'neon'` default provider label. The label is persisted in the `auth_identity` rows, so changing it is a data decision.                                    | Rename the helper. Changing the persisted label needs its own migration decision and is not this lane's to make. |
| `packages/auth/src/client.ts`, `packages/auth/src/server.ts`, `packages/auth/src/index.ts` | The provider-named exports (`createNeonClientAdapter`, `createNeonServerAdapter`, `handleNeonAuthRequest`). The provider-neutral aliases already exist and the application now uses them. | Drop the provider-named exports once no caller remains.                                                          |
| `packages/auth/src/vite-client-bundle.ts`                                                  | The `@neondatabase/auth` adapter deny pattern.                                                                                                                                            | Keep until the dependency goes; remove the dependency and the pattern together.                                  |
| `packages/auth/package.json`, `apps/web/package.json`                                      | The `@neondatabase/auth` dependency.                                                                                                                                                      | Remove the dependency, then the deny rules that guard it.                                                        |
| `packages/auth/tests/**`                                                                   | Unit and integration tests for the above.                                                                                                                                                 | Follow the source removal.                                                                                       |
| `package.json`, `scripts/integration-inventory.mjs`                                        | The root coverage command and the integration inventory name `packages/auth/tests/integration/neon-driver.test.ts`.                                                                       | Follow the test removal.                                                                                         |
| `apps/web/test/desktop-principal.test.ts`                                                  | A fixture whose provider label is `'neon'`.                                                                                                                                               | Follow the provider-label decision.                                                                              |

### 3b. CI and release lane (F)

| File                                                                                                                                     | Active coupling                                                                                                                                                                     | Scoped action                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/neon_workflow.yml`                                                                                                    | The whole workflow: it created an isolated hosted branch, proved the key-discovery endpoint, migrated the branch and deleted it. It was the last active provider integration in CI. | **Removed by #1516 (merged 2026-10-20T18:04:26Z)**, which replaced the hosted branch proof with the provider-free disposable loopback proof. The file is not in the tree. |
| `.github/workflows/cloudflare-db-migrate.yml`                                                                                            | The header named the provider and the production branch.                                                                                                                            | **Reworded by #1516**; the header names no provider and the workflow itself only needs `DATABASE_MIGRATION_URL`.                                                          |
| `scripts/neon-branch-resolution.test.ts`, `scripts/neon-workflow-lifecycle.test.ts`, `scripts/neon-workflow-disposable-postgres.test.ts` | Tested the shipped workflow's shape and its cleanup resolver.                                                                                                                       | **Removed by #1516** with the workflow.                                                                                                                                   |
| `scripts/test-target-guard.mjs`, `scripts/test-target-guard.test.ts`                                                                     | The CI-ephemeral host allow-list was keyed on the hosts that workflow emitted, and `NEON_AUTH_BASE_URL` was the one remote value it admitted.                                       | **Removed by #1516** after the workflow was gone. The guard now admits only the exact hosts a caller names itself.                                                        |
| `scripts/test-suite-boundary.test.ts`                                                                                                    | Asserted the workflow's job names and the `Migrate Neon Branch` gate.                                                                                                               | **The workflow's job names and gate are gone with #1516.** The file still names the auth lane's `neon-driver` test, which the auth lane owns.                             |
| `apps/web/start/acceptance-hosted.mjs`                                                                                                   | The hosted acceptance harness runs against that branch.                                                                                                                             | Repoint it at the Railway target or the disposable proof.                                                                                                                 |

### 3c. Other owners

| Owner                | File                                    | Active coupling                                                                                           | Scoped action                                                                                                                                    |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| E (caching and lock) | live Hyperdrive `adea-db` configuration | Query caching is enabled on the edge pooler, and the origin connection limit is 20.                       | The pooler is a live Cloudflare setting. Changing the cache or the limit is a production operation, not a repository change. It is listed below. |
| E                    | `packages/db/src/connection.ts`         | The Worker client is capped at five edge connections and the server client at ten; `idle_timeout` is 20s. | The efficiency measurement below is the input to any tuning decision.                                                                            |
| C (Pi runtime)       | —                                       | No provider coupling was found in the Pi runtime.                                                         | None.                                                                                                                                            |

## 4. Historical accountability records retained

These name the provider and are kept on purpose. Each is a record of what the deployment was, and
none of them is a path the runtime or the deployment configuration still takes.

| File                                          | What it records                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/authentication.md`                      | The legacy hosted Auth environment is retained, unchanged, as an accountability record. It is not a recovery target: recovery for the Railway deployment is a Railway backup/restore or a forward fix.                                              |
| `docs/database-operations.md`                 | The old production principal name, the old plan's limitations, and the pull-request CI lane's provider. The page states that its provider-specific references describe the CI lane and the historical record, not this application's configuration. |
| `docs/guides/railway-cutover-checklist.md`    | The cutover plan and the retention invariants. Owned by the acceptance lane; its open pull request also touches it, so this lane did not edit it.                                                                                                   |
| `docs/guides/railway-cost-week-plan.md`       | The cost-measurement plan. Owned by the acceptance lane.                                                                                                                                                                                            |
| `PERF.md`                                     | A 2026-09-26 measurement taken against a remote branch.                                                                                                                                                                                             |
| `docs/decisions/0007-solid-tanstack-start.md` | A decision record.                                                                                                                                                                                                                                  |
| `CHANGELOG.md`                                | Release history.                                                                                                                                                                                                                                    |

## 5. Naming-only references kept

| File                                                                                                                    | Why it stays                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/tests/unit/config.test.ts`, `packages/db/tests/unit/connection.test.ts`                                    | The regression that proves the retired endpoint shape is no longer special-cased names that shape. Removing the name would remove the regression's meaning.                                                                                                                                                                     |
| `scripts/identity-boundary.test.ts`                                                                                     | Refuses provider-shaped user-id fields. A gate.                                                                                                                                                                                                                                                                                 |
| `scripts/desktop-auth-boundary.test.ts`, `apps/web/start/client-policy.mjs`, `apps/web/test/start-client-denylist.json` | Refuse the legacy SDK in the client graph. Gates that guard a dependency that still exists.                                                                                                                                                                                                                                     |
| `apps/web/start/client-policy.mjs` (the private-environment list)                                                       | The legacy auth names stay denied while the auth lane's legacy reader, driver and dependency are still in the tree. These are output deny markers: they keep a name out of the browser bundle whether or not anything still reads it, so removing one before its reader is gone weakens the check rather than proving anything. |
| `scripts/test-target-guard.test.ts`, `scripts/relay-retention-config.test.ts`, `packages/db/tests/integration/**`       | Fixture host names. They reach nothing.                                                                                                                                                                                                                                                                                         |

## 6. Measurement

The full series is in
[the measurement file](lane-h-cloudflare-railway-measurement-2026-10-20.json). The summary:

| UTC day                | Requests | Errors | `exceededResources` | Subrequests per request | CPU p50 of the bucket p50 (µs) |
| ---------------------- | -------- | ------ | ------------------- | ----------------------- | ------------------------------ |
| 2026-10-13             | 491      | 0      | 0                   | 6.02                    | 33,811                         |
| 2026-10-14             | 2,907    | 478    | 478                 | 6.76                    | 18,306                         |
| 2026-10-15             | 8,074    | 2,539  | 2,539               | 6.79                    | 12,947                         |
| 2026-10-16             | 8,972    | 4,879  | 4,879               | 6.94                    | 10,000                         |
| 2026-10-17             | 7,997    | 2,306  | 2,306               | 6.94                    | 16,591                         |
| 2026-10-18             | 729      | 0      | 0                   | 2.08                    | 23,612                         |
| 2026-10-19             | 1,635    | 0      | 0                   | 2.49                    | 20,019                         |
| 2026-10-20 (to 07:30Z) | 867      | 0      | 0                   | 3.61                    | 23,170                         |

Three readings, each with its limit:

- **The CPU overruns stopped.** Every `exceededResources` invocation in the series falls on
  2026-10-14 to 2026-10-17, and the three days since are free of them. The repository's
  [local CPU profiling evidence](worker-cpu-local-profiling-2026-10-18.json) recorded "307 rolling
  24h CPU overruns" as of 2026-10-18T15:20Z, provided by the coordinator and not independently read.
  The per-script GraphQL series does not reproduce that counter: it reports 2,306 overruns on
  2026-10-17 and none on 2026-10-18. The two figures measure different things, and the series here
  is the per-script read.
- **The request mix changed on 2026-10-18, not only its volume.** Subrequests per request fell
  from 6.0–6.9 to 2.1–3.6 on the same day. Daily requests also fell by roughly a factor of five.
  The overrun-free days are therefore also the low-traffic days, and this series does **not**
  establish that the fix holds at the 2026-10-15 to 2026-10-17 load.
- **The CPU figures are raw reservoir samples, not billed CPU.** Each bucket's quantiles are a
  sample over the invocations in that minute. Billed CPU was not established by this read.

Per-route CPU and subrequest attribution is **not** available from the route this lane could use.
The Workers Logs observability dataset exposes 22 keys, all `$metadata.*`, and returns zero matching
rows for `adea-web` over the read window. Hyperdrive query and cache counters are not readable
either: the account schema has no Hyperdrive group, and the account-level Workers analytics
dataset answers HTTP 500. Both negative results are recorded in the measurement file.

The Railway read reached one project, `control-plane`, which is the Control Plane service's own
infrastructure with its own runbooks. Over the read window its production Postgres service reported
zero CPU and memory, and its API service reported zero requests. **Those zeros are a timestamped
observation of one read of one project, not evidence about what exists.** A service that reported
zero usage in that window may be idle, may not have been reached by the query, or may not be visible
to this credential, and the same zeros say nothing about whether a production PostgreSQL instance
exists for the auth database. The read saw no service for the auth database in that project, and
this credential reaches no other Railway project or workspace. **Whether a production PostgreSQL
instance for the auth database exists is not established by this read, in either direction.**

## 7. Bounded efficiency changes

The measurement supports one change in the database layer, and this lane made it.

**The per-connection statement mode is no longer decided by a hostname.** The repository's local
profiling evidence named the local PostgreSQL SCRAM handshake and the per-connection type discovery
among the top CPU frames, and the deployed series shows a per-minute CPU p50 of 10–34 ms with a
bucket p99 above 350 ms. Those figures do not attribute CPU to any one route, so this lane did not
guess at a per-route fix and did not cache any authentication, session or permission decision: the
Worker still reads every authorization decision fresh.

What changed is narrow and testable:

- The connection role is no longer sniffed from a provider hostname, so no deployment can be
  misclassified by a name it happens to carry.
- The deploy-time validator identifies the PostgreSQL instance a connection addresses by its host,
  its port and its database name, and requires the runtime, migration and unpooled connections to
  agree on all three. A host name is a name, not evidence about which server answers it, so no
  host name is rewritten and no lookalike is forgiven.

Both are covered by regressions in `packages/db/tests/unit/config.test.ts`,
`packages/db/tests/unit/connection.test.ts` and `scripts/database-config.test.ts`.

### The edge query cache is a separate thing, and it is on

The ORM's in-process cache and the edge pooler's query cache are different mechanisms in different
places, and this lane's change touches neither. Two facts have to be kept apart:

- The drizzle database in `packages/db/src/connection.ts` owns `$cache: undefined`, and the Worker
  reads every authorization decision fresh. That is the repository's own behaviour and it is
  unchanged by this pull request.
- The live edge pooler has **query caching enabled**: root read `caching.disabled = false` at about
  08:00–08:02 UTC on 2026-10-20, and this lane's 07:30Z read recorded the same value. That cache
  lives on the Cloudflare binding, outside this repository, and no change in this pull request
  turns it off.

So the repository's in-process cache being off says nothing about the edge cache, and this pull
request establishes nothing about it either way. **Cache-disabled routing for authentication,
session and permission reads is a cutover prerequisite**, and it is a live Cloudflare setting that
root owns. It is listed below as such, and it is not a prerequisite this patch satisfies.

Two further levers are available and are **not** taken here, because they are live settings or
another lane's:

- The edge pooler's origin connection limit (20) and its query-cache setting.
- The Worker client's edge-connection ceiling (5) and its idle timeout (20s).

## 8. Local development proof

This is the no-provider proof for a local shutdown. It covers what a developer
machine and the local test lanes actually reach.

| Local surface                           | What it reaches                                                                                                      | Provider reference                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `compose.yml`                           | One pinned PostgreSQL container on `127.0.0.1:55432`.                                                                | None.                                                  |
| `apps/web/.env.example`                 | The same loopback database, and the auth service's own `AUTH_BASE_URL`, `AUTH_SECRET` and `AUTH_DATABASE_URL`.       | None.                                                  |
| `apps/web/.dev.vars.example`            | The same.                                                                                                            | None.                                                  |
| `bun run dev`                           | The Vite dev server with the loopback database and the local auth service.                                           | None.                                                  |
| `bun run test:integration`              | The loopback database, with `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `DATABASE_MIGRATION_URL` all pointing at it. | None.                                                  |
| `bun run test:e2e`, `bun run test:unit` | The same loopback database.                                                                                          | None.                                                  |
| `packages/db/src/config.ts`             | The connection rules.                                                                                                | None: the statement mode is not decided by a hostname. |
| `scripts/database-config.mjs`           | The deploy-time configuration check.                                                                                 | None: the comparison names no provider.                |

The pull-request CI workflow that was the one provider-dependent path left in the
repository was removed by #1516 (merged 2026-10-20T18:04:26Z) and replaced with
the provider-free disposable loopback proof. The provider-dependent paths that
remain are the auth package's legacy reader, driver, client SDK dependency and
persisted provider label, which are the auth lane's to remove and are listed
below.

A developer machine therefore needs a PostgreSQL server, not that provider. The
container image is digest-pinned and the registry fallback is already handled
by `scripts/docker-pull-backoff.mjs`, so a rate-limited pull is retried rather
than turned into a reason to reach for a hosted branch.

## 9. Production operations needing root approval

Root owns every live action. This lane performs none of them, and each step below is separate and
needs its own approval.

**Two facts the previous revision of this page got wrong are corrected here.** Both were this
lane's own overstatement, and both would have made the cutover unsafe to plan:

- **Repointing the existing edge pooler mutates the database the deployed Worker is using, at once.**
  Hyperdrive `adea-db` is bound to the live Worker, so changing its origin changes where the
  running Worker sends every database query the moment the change lands. It is not isolated
  preparation, and it cannot be done "before the merge" without the current Worker starting to
  reach a different database.
- **A missing Secrets Store record does not block the deployment.** `apps/web/src/server/worker-bindings.ts`
  resolves Secrets Store bindings lazily, per request, and a read failure is caught and swallowed:
  the hydration deletes the environment value and the consuming guard returns its "not configured"
  response. A missing record therefore does not fail the build, does not fail the deploy, and does
  not leave the previous Worker serving. It surfaces at request time. This page previously claimed
  the opposite; the claim is withdrawn.

The consequence is that the cutover needs **positive validation** rather than an assumed
fail-closed deployment.

### The two authorized shapes

Either shape is acceptable, and the choice is root's:

| Shape                              | What it is                                                                                                                                                                                  | What it requires                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Coordinated authorized cutover** | The pooler repoint and the new Worker version land together, as one approved change, with the Railway target fully prepared first.                                                          | One approval covering both. The preparation below must be complete and verified _before_ the repoint, because the instant the pooler changes is the instant the live Worker reaches the new database.                                            |
| **Separately prepared binding**    | A second edge pooler is prepared against the Railway origin and the new Worker version binds it. The existing `adea-db` and the live Worker are untouched until the new version is serving. | Root creates the new pooler and supplies its id. The id in `apps/web/wrangler.jsonc` and `apps/web/cloudflare.config.ts` is then the new one, so **this pull request needs that id before it merges** — which is why the id is not changed here. |

This pull request implements the first shape's _repository_ half: it keeps the existing pooler id
and changes the bindings the Worker deploys with. The cutover itself is root's action.

### The preparation that must be verified first

None of this is performed or authorized by this lane.

| #   | Action                                            | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Why it is root's                                             |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Create the Railway database and the auth database | One Railway-managed PostgreSQL with the `app` and `auth` schemas, the `_app` runtime roles and the `_migration` role, and the auth schema initialized by `bun run --cwd packages/auth schema-init -- --apply`.                                                                                                                                                                                                                                                          | Provisioning, roles and schema creation are live operations. |
| 2   | Create the four Secrets Store records             | `ADEA_RAILWAY_PRODUCTION_DATABASE_URL`, `ADEA_RAILWAY_PRODUCTION_AUTH_BASE_URL`, `ADEA_RAILWAY_PRODUCTION_AUTH_SECRET`, `ADEA_RAILWAY_PRODUCTION_AUTH_DATABASE_URL`, in the account Secrets Store the Worker already reads.                                                                                                                                                                                                                                             | A credential creation. The lane does not create credentials. |
| 3   | Decide `AUTH_BASE_URL`                            | It is the public app origin Better Auth scopes its cookies to. The Worker serves `adea.dev` and `adea-web.adea-ai.workers.dev`; one base URL means one of them is the cookie host. The record is in the store rather than in the repository so the value can be set without a code change.                                                                                                                                                                              | A live value with a user-visible consequence.                |
| 4   | Verify the target before it is switched to        | **Positive validation, because nothing validates it by itself.** Read each of the four store records back and confirm each resolves; confirm the Railway target answers on the runtime role and on the migration role; confirm the `app` schema and its tables and the `auth` schema and its tables are present and initialized; confirm the health probe's own checks pass against the target (`node scripts/database-health.mjs` with the three canonical variables). | A live read of a live target.                                |
| 5   | Move the pooler, in the chosen shape              | Repoint `adea-db` to the Railway origin **as one change with the deploy**, or prepare a second pooler and bind that. See the two shapes above.                                                                                                                                                                                                                                                                                                                          | A live Cloudflare setting on a production binding.           |
| 6   | Merge the pull request                            | The merge deploys the Worker with the new binding set. It does **not** validate steps 2 or 4: the deployment succeeds whether or not the records resolve, and a record that does not resolve shows up at request time as "not configured".                                                                                                                                                                                                                              | A deployment.                                                |
| 7   | Verify the bindings resolved, then observe        | After the deploy, confirm the Worker resolves each of the four bindings — a failing resolution is silent by construction — and then record sign-in, refresh, logout and revocation outcomes, the verification deliveries, the Workers CPU-overrun counter, and the request and subrequest counts.                                                                                                                                                                       | Live observation.                                            |
| 8   | Retire the legacy bindings                        | Delete `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL`, `AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL` and `AGENT_HQ_WORKER_AUTH_COOKIE_SECRET` from the store, once the observation window is clean.                                                                                                                                                                                                                                                                                 | A credential deletion.                                       |

**Four prerequisites of the runtime Railway bindings are separate from this pull request, and none
of them is established by it.** The bindings this pull request deploys resolve lazily, per request,
and a record that does not resolve surfaces at request time rather than failing the deployment, so
nothing in the repository validates them. Four distinct things have to hold before a
deployment-affecting merge of this pull request is trusted, and this pull request establishes none
of them:

1. **A prepared Railway target that has been verified.** The Railway database and the auth
   database, the four Secrets Store records and the target itself have to exist and be read back,
   answered on the runtime and migration roles, and checked for the `app` and `auth` schemas and
   their tables. That is steps 1 to 4 above, and this pull request performs none of it.
2. **Strict TLS on the prepared target's URLs.** The Railway target is a hosted PostgreSQL
   instance, and this pull request's own validator refuses a hosted URL that does not require TLS:
   `scripts/database-config.mjs` accepts `sslmode=require`, `verify-ca` or `verify-full` for a
   hosted target and refuses every other mode. The prepared target's runtime, migration and
   unpooled URLs therefore have to carry a verifying TLS mode, and the health probe refuses the
   target otherwise. This pull request supplies the rule; it prepares no target that meets it.
3. **The production binding change.** The pooler move is a live Cloudflare setting on a production
   binding: either `adea-db` is repointed to the Railway origin as one change with the deploy, or a
   second pooler is prepared against the Railway origin and the new Worker version binds that. In
   the second shape the new pooler's id is needed in `apps/web/wrangler.jsonc` and
   `apps/web/cloudflare.config.ts` before this pull request can merge, which is why the id is not
   changed here.
4. **Cache-disabled routing for authentication, session and permission reads.** The live pooler has
   query caching enabled; the cache lives on the Cloudflare binding, outside this repository, and
   root owns it. It has to be disabled, or the pooler that serves those reads has to be one without
   it, before the cutover is accepted.

**This pull request does not activate those bindings, does not deploy, does not provision, and does
not mutate Railway or production, and it makes no claim that any of those four prerequisites is
satisfied.**

**Not required, and deliberately not done:** deleting, dropping, truncating or altering any provider
branch, database, role or table. The legacy environment is retained untouched as an accountability
record.

**Recovery for the Railway deployment is a Railway backup/restore or a forward fix.** There is no
provider fallback, no backward-compatibility path and no provider rollback. The proposed rollback
plan in the cutover checklist stays on the record as history; it is not an active dependency.

## 10. Coordination with the pull-request database lane

`scripts/database-config.mjs` is read by the health probe (`scripts/database-health.mjs`), which
the pull-request database lane runs before its migrations. Two pull requests touch that file, and
the coordination has to be settled at integration rather than by either owner editing the other's
paths.

| Pull request     | Owner              | Change to `scripts/database-config.mjs`                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1515 (this one) | H (this lane)      | Removes the provider-named endpoint rules and the host-name normalisation with them. Identifies the PostgreSQL instance by its host, its port and its database name, and requires the runtime, migration and unpooled connections to agree on all three. No name is rewritten and no lookalike is forgiven.                                                                                                                   |
| #1516            | F (CI and release) | Removed the provider-named **CI** surface — the hosted branch workflow, its three tests and the CI-ephemeral host allow-list — and **merged on 2026-10-20T18:04:26Z**; it replaced the hosted branch workflow with a provider-free disposable loopback proof. It did **not** change this file: the exact rule here is this lane's, and #1516's own record states that its edit of `scripts/database-config.mjs` was reverted. |

**The overlap and its resolution.** Two revisions of this lane's rule have been reviewed. The first
compared the literal host, which broke the still-active hosted branch lane deterministically:
that lane builds `DATABASE_URL` from the pooled endpoint and `DATABASE_MIGRATION_URL` from the
direct endpoint of one branch, so the health probe failed before it reached the database query. The
second forgave a pooler marker in the host name. That fixed the branch lane and introduced a worse
defect: rewriting a host name cannot prove that two addresses are one server, and it forgave every
lookalike — `evil-pooler.example.test` and `evil.example.test` were accepted as one instance.

The third revision removes the forgiveness. The instance is identified by the host, the port and the
database name, all three exactly, and two host names are never equal by resemblance.

**The merge precondition is discharged.** The exact rule refuses the hosted branch lane's two-endpoint
shape, so that lane's health probe failed while the workflow still existed. #1516 removed the
workflow and replaced it with the provider-free disposable loopback proof, which addresses one
instance through one host and one port through all three variables and which the exact rule
accepts. **#1516 was merged on 2026-10-20T18:04:26Z, before this pull request**, so the
precondition no longer holds and the pull-request database lane is not waiting on it. What is
discharged there is the **CI dependency**; this pull request's own exact host, port and database
name validator is still pending its own merge.

**The two versions of `scripts/database-config.mjs` are not reconciled on `main`.** At current `main`
= `227bfe48fc5efae212a4f69f0261bd54f478e62d`, that file still carries `normalizedNeonHost` (`:59`),
`hostname.replace('-pooler.', '.')` (`:60`), the comparison that uses that rewrite (`:92`) and the
provider-specific `.neon.tech` endpoint conditions (`:97-103`). **This pull request's exact host,
port and database name validator is pending its own merge** — #1515 is not on `main`, and the
host-name rewrite it removes is still there. What #1516 brought to `main` is its CI replacement, the
provider-free disposable loopback proof. **The repository-wide removal of the provider-named host
handling is therefore not complete; it completes when this pull request merges.**

**The health gate is not weakened.** The comparison is strictly stronger than the one it replaces:
the original code never compared the runtime and migration hosts at all, and this lane's rule
requires all three parts of the instance identity to agree. No provider fallback is restored, and no
gate is skipped.

**Both lanes are exercised.** `scripts/database-config.test.ts` carries, as regressions, the managed
deployment shape and the loopback shape (both accepted, with the host, the port and the database
name exact), and the refusals: two different hosts, the hosted branch lane's pooled and direct
endpoint pair in both orders, two ports on one host, one host and one port carrying two databases,
and the adversarial lookalikes a host-name rewrite would have accepted — a pooler marker in the
middle of a label, the marker twice, and the marker on an unrelated name.

## 11. What this audit does not establish

- **It does not establish that the live migration is complete.** The live Worker still binds the
  provider's legacy auth names and the edge pooler still fronts the provider's host, which root
  read directly at about 08:00–08:02 UTC on 2026-10-20. This pull request changes what the
  repository deploys; it changes nothing live, and no production mutation is authorized.
- It does not establish that the edge query cache is off, for authentication, session or permission
  reads or anywhere else. The live pooler has query caching enabled, the cache lives outside this
  repository, and the repository's own in-process cache says nothing about it.
- It does not establish that the provider is gone from the live deployment. The live Worker still
  binds it, and the table above says what ends that.
- It does not establish billed Cloudflare CPU, per-route attribution, or Hyperdrive query and cache
  counters. The routes for those were tried and are recorded as negative results.
- It does not establish that the CPU-overrun fix holds at the 2026-10-15 to 2026-10-17 traffic
  level. The overrun-free days are also the low-traffic days.
- It does not establish that a production PostgreSQL instance for the auth database exists, or that
  none exists. The zero-metric record of the reachable Railway project is a timestamped observation
  of one read, not a statement about what is deployed. The read saw no service for the auth
  database in the reachable project, and the credential reaches no other project.
- It does not complete the wider database migration. It covers this repository's application
  database and its auth configuration. The Control Plane service carries its own Railway
  configuration and runbooks in its own repository.
- It does not measure cost. The seven-day cost interval is a measurement the user runs next week
  with the [cost week plan](../guides/railway-cost-week-plan.md) as its procedure; it is not a
  gate on this migration, and nothing here waits for it.

### Withdrawn claims

Four statements in earlier revisions of this page were wrong, and they are withdrawn rather than
quietly edited:

- _"If step 2 has not happened, the deploy fails closed and the previous Worker keeps serving."_
  False. Secrets Store bindings resolve lazily per request and a read failure is suppressed, so a
  missing record does not fail the build, does not fail the deploy, and does not leave the previous
  Worker serving. It surfaces at request time as "not configured".
- _"Repoint the edge pooler" as a preparation step, before the merge._ False as a description of a
  safe preparation. Repointing `adea-db` changes where the running Worker sends its queries at
  once. It is either part of a coordinated authorized cutover or it is done on a separately
  prepared binding.
- _"The instance comparison forgives only the pooler marker."_ True of the revision it described
  and false as a statement about instances. Rewriting a host name cannot prove that two addresses
  are one server: it accepts any lookalike, and it accepted `evil-pooler.example.test` with
  `evil.example.test`. The rule now identifies the instance by its host, its port and its database
  name, and forgives nothing.
- _"The two versions of `scripts/database-config.mjs` have already been reconciled on `main`, and
  the host-name rewrite this lane removed is not present there."_ False as a statement about `main`.
  #1516, merged 2026-10-20T18:04:26Z, removed the provider-named **CI** surface — the hosted
  branch workflow, its three tests and the CI-ephemeral host allow-list — and did not change
  `scripts/database-config.mjs` at all. At `main` = `227bfe48fc5efae212a4f69f0261bd54f478e62d` that
  file still carries `normalizedNeonHost` (`:59`), `hostname.replace('-pooler.', '.')` (`:60`) and
  the provider-specific `.neon.tech` endpoint conditions (`:97-103`). This pull request's exact
  validator is pending its own merge, and the repository-wide removal of the provider-named host
  handling is not complete until it merges.
