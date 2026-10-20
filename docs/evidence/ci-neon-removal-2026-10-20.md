# CI has no Neon dependency — the audit, the removal and the proof

Branch: `codex/20261020-ci-release-w7`. Base: `origin/main` = `333b948d4c5fba1f88d98d764c075b790be6ee22`.
Read on 2026-10-20 from a local checkout. No credential was read, no secret was
created or changed, no hosted database was reached, no branch was created or
deleted anywhere, and no release, deploy or readiness change was made.

Railway is the sole production target. This record states what the CI surface
depended on before this change, what it depends on now, how that is proved, and
which Neon identifiers remain outside this lane's scope.

## What the CI surface depended on

The pull-request database lane was `.github/workflows/neon_workflow.yml`. It ran
four jobs, and three of them were Neon-specific:

| Job                         | Check name                    | What it did                                                                                                                               |
| --------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `neon_proof`                | `Neon Preview Proof`          | Created a Neon branch, built restricted database URLs for it, proved the Neon Auth JWKS endpoint, and ran the migration checks against it |
| `migrate_gate`              | `Migrate Neon Branch`         | The fail-closed gate over `setup` and `neon_proof`                                                                                        |
| `delete_neon_branch`        | `Delete Neon Branch`          | Listed the project's Neon branches on close and deleted this pull request's by id                                                         |
| `setup`                     | `Setup`                       | Resolved the branch name the Neon branch was created with                                                                                 |
| `disposable_postgres_proof` | `Disposable PostgreSQL Proof` | Proved a disposable PostgreSQL 18 instance on the loopback interface                                                                      |
| `disposable_postgres_gate`  | `Prove Disposable PostgreSQL` | The fail-closed gate over the disposable proof                                                                                            |

The lane required three repository secrets (`NEON_API_KEY`,
`NEON_CI_APP_PASSWORD`, `NEON_CI_MIGRATION_PASSWORD`), one repository variable
(`NEON_PROJECT_ID`), the Neon branch lifecycle API (`console.neon.tech`), the
Neon Auth JWKS endpoint, and two CI-written host allowlists
(`ADEA_CI_BRANCH_HOSTS`, `ADEA_CI_AUTH_HOSTS`) that the test-target guard
accepted as "CI-ephemeral" targets.

Three scripts existed only to pin that lane: `scripts/neon-workflow-lifecycle.test.ts`,
`scripts/neon-branch-resolution.test.ts` and
`scripts/neon-workflow-disposable-postgres.test.ts`. The disposable proof's own
assertions lived in the last one, together with the assertions that kept the
hosted Neon proof unchanged.

## What the CI surface depends on now

`.github/workflows/database-proof.yml` replaces the removed workflow. It has two
jobs and no others:

- `Disposable PostgreSQL Proof` — unchanged steps, unchanged check name. It
  checks out the pull request, installs Bun 1.4.3 and the pinned PostgreSQL 18
  client tools, and runs `bun --no-env-file run scripts/disposable-postgres-cli.ts`.
  It reads no secret and reaches no hosted database.
- `Prove Disposable PostgreSQL` — the unchanged fail-closed gate. It reports on
  every ready pull request, so it never blocks an unrelated pull request, and a
  draft pull request runs no job at all.

The check names are unchanged, so the disposable lane's existing evidence stays
attached to the same checks. The gate that changed shape is the provider gate:
`Migrate Neon Branch` is gone with the provider proof it gated. It was **not**
a required status check — the live `code-foundry-main` ruleset requires
`Validation / Gate`, `Review Policy / Gate`, `Visual gate` and `Host gate`
(verified against the live ruleset `22403584` on 2026-10-20), so no required
check stopped reporting.

The test-target guard lost the CI-ephemeral classification with it. A database
target is now `local` (loopback or a unix socket), `production` (a host this
repository knows serves production) or `remote` (everything else). Nothing
writes a CI-provided host allowlist any more, and no role name and no
`GITHUB_ACTIONS` value vouches for a host.

A remote target is still reachable in exactly one way, and it was reachable
before this change too: a developer names its exact host in
`ADEA_ALLOW_REMOTE_TEST_TARGET`, and the guard accepts that one host. That is
an explicit, per-run choice by a person, not something a CI lane or a stray
environment variable can do. A production host is never accepted, however it
is named. So the change removes the CI-wide, machine-driven path to a remote
database and leaves the deliberate, per-run one exactly as it was.

The database configuration probe lost its provider-specific host rule. It still
refuses a client-exposed credential, a missing role convention, a pooled and an
unpooled connection that name different environments, and a hosted connection
without TLS.

## The proof

`scripts/no-neon-ci.test.ts` is the machine-checked proof. It scans the
workflows, the CI configuration, the release configuration and the database CI
scripts for a provider **identifier** — an environment variable name, a host, an
action — and fails when one appears. Identifiers, not prose: a refusal may name
a legacy value and a comment may explain why.

| Case                                                      | What it proves                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| no workflow names a provider identifier                   | every workflow file is clean                                                                                |
| no workflow requests a provider secret or variable        | no workflow asks the repository for a provider credential                                                   |
| the CI and release configuration name no provider         | `.github/code-foundry.yml`, `release-please-config.json`, the manifest and `package.json` are clean         |
| the database CI scripts name no provider                  | apart from one documented refusal (below)                                                                   |
| the refusal is still a refusal, and nothing supplies it   | the guard lists the legacy variable and refuses a hosted endpoint for it; no workflow sets it               |
| the pull-request database proof is the only database lane | the provider workflow is gone and the remaining lane is local                                               |
| no CI lane supplies a remote database host to the guard   | the guard has no CI-provided allowlist and no `ci-ephemeral` classification                                 |
| a developer may still name one exact remote host          | `ADEA_ALLOW_REMOTE_TEST_TARGET` still accepts that one host, and a production host is never accepted        |
| the one provider path this lane does not own is recorded  | the efficiency lane's pull request owns `scripts/database-config.mjs` and removes its provider rule         |
| no provider identifier appears that no record allows      | a new identifier fails in a path this lane owns and in a path another lane owns alike                       |
| the combined state names no provider but the refusals     | over a disposable copy of the surface, the state the repository reaches when the owning pull request merges |

`scripts/database-proof-workflow.test.ts` pins the surviving lane: its two
jobs, their check names, the fail-closed gate, the trigger set, the pinned
actions and the pinned toolchain, and the disposable proof's own guarantees
(loopback binding, canonical roles, TLS, cleanup, no credential in the output).

## The one identifier that remains, and why

`NEON_AUTH_BASE_URL` is still named in `scripts/test-target-guard.mjs` and in
its test. It is the legacy Neon Auth binding the **product** still reads
(`packages/auth/src/config.ts`, `apps/web/cloudflare.config.ts`). The guard
lists it so a hosted legacy auth endpoint is refused for a test; refusing a
value is not a dependency on the value. Nothing in CI supplies the variable,
and no lane needs a hosted Neon Auth service to run.

The product-side removal of that binding belongs to the lane that owns
`packages/auth` and the Cloudflare configuration. It is listed in the
coordination record, not taken here.

## The historical record is kept

Nothing in this change deletes an accountability record. The Railway cutover
checklist keeps its "Neon-recoverable preservation" section and its record of
what was retained; the removal of the provider lane from CI does not retire
that record, and the retained environment is not a recovery target for CI. The
release notes for the change are this file and the coordination record beside
it.

## What is routed to its owner, not taken here

These identifiers remain outside this lane's scope. They are recorded so the
owner of each path can schedule them; this change does not touch them.

| Path                                                                                          | Identifier                                                                          | Owner                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/auth/src/config.ts`, `packages/auth/src/server.ts`, `apps/web/cloudflare.config.ts` | `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `AGENT_HQ_NEON_PRODUCTION_*`       | the auth/deployment lane                                                                                                  |
| `packages/auth/src/neon-driver.ts`, `packages/auth/tests/integration/neon-driver.test.ts`     | the legacy Neon Auth driver                                                         | the auth lane                                                                                                             |
| `packages/db/src/config.ts`                                                                   | `isTransactionPooledHost`, `NEON_HOST_SUFFIX`                                       | the database lane                                                                                                         |
| `apps/web/src/**`, `apps/web/test/**`                                                         | `NEON_AUTH_*` bindings and the client denylist                                      | the web lane                                                                                                              |
| `scripts/preview-availability.test.ts`                                                        | `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL` as a refused production-secret name         | the web/deployment lane                                                                                                   |
| `scripts/database-config.mjs`                                                                 | the `.neon.tech` pooled/unpooled host rule                                          | the efficiency lane's pull request #1515, which owns the path and replaces the rule with a stronger, provider-neutral one |
| `scripts/disposable-postgres-ci.ts`                                                           | the header comment naming the hosted Neon branch and the `Migrate Neon Branch` gate | the lane that owns the disposable proof script                                                                            |
| `docs/evidence/toolchain-cache-campaign-2026-10-17.json`                                      | a recorded path to the removed workflow                                             | a historical record; the path is not corrected, because correcting it would rewrite the record                            |
