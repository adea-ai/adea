# Railway production source plan

The plan answers one question: what is the production target right now, and is that answer
good enough to act on? It answers it from two sources — the repository's own declaration in
`.railway/production-source.js` and a live read of the deployment — and it refuses rather
than guess.

The plan is a read. It authorizes nothing: it does not provision, deploy, cut over, promote,
migrate, change a credential, or mutate production. The cutover itself is described in
[Railway cutover checklist](railway-cutover-checklist.md), the recovery that reverses it in
[Railway PostgreSQL recovery](railway-postgres-recovery.md), and the cost measurement that
follows a verified cutover in [Railway cost week](railway-cost-week-plan.md). This document
describes only the plan that says which production target the repository believes it has.

## The declaration

`.railway/production-source.js` is the repository's declaration of its production source, and
`.railway/production-source.d.ts` is its type. The declaration records four things:

| Field              | What it states                                                                        |
| ------------------ | ------------------------------------------------------------------------------------- |
| `environment`      | the environment production traffic runs in                                            |
| `targets`          | the candidate production targets; one is a plan, none is a refusal, more is ambiguous |
| `requiredMetadata` | the deployment metadata every production deployment must publish                      |
| `pinnedMetadata`   | the metadata values the repository pins, by field                                     |

The declaration is deliberately narrow. Railway project and service identifiers are provider
configuration rather than domain identifiers, and this repository does not record them; the
reasoning is in [Diagram sources](../architecture/diagram-sources.md). What the repository
records is the shape of a production deployment, not the identifiers of one. A release, an
image digest, a region or a promotion time belongs in the receipt of the change that produced
it, not in the source tree, so `pinnedMetadata` is empty today.

## The live reads

The plan needs two reads of the deployment, and it names both:

| Read          | Command it describes             | What it establishes                               |
| ------------- | -------------------------------- | ------------------------------------------------- |
| `status`      | `railway status --json`          | the production target and its deployment metadata |
| `deployments` | `railway deployment list --json` | the deployment history, newest first              |

The plan itself runs no command. The caller injects a command runner, and the runner is the
only thing that can reach the deployment:

```js
const { planProductionDeployment } = await import('./scripts/railway-production-plan.mjs')

const plan = planProductionDeployment({
  run: (request) => ({ status: 0, stdout: readSomehow(request.command), stderr: '' }),
})
```

The runner receives the kind of the read, the command it describes and the timeout to apply,
and answers with `{ status, stdout, stderr }`, or `{ timedOut: true }` when it gave up, or
throws when it could not start. A plan without a runner is a refusal, never an empty plan: the
plan module imports no child process, starts nothing and reaches no network of its own.

The reads are JSON, and the plan refuses a read it cannot parse rather than plan on a payload
it did not understand. A status read answers with the candidate targets and the deployment
metadata; a deployments read answers with the deployment history, newest first:

```json
{
  "targets": [{ "project": "adea", "service": "auth", "environment": "production" }],
  "deployment": {
    "release": "v0.99.0-dev.488",
    "imageDigest": "sha256:…",
    "region": "iad1",
    "promotedAt": "2026-10-20T00:00:00Z"
  }
}
```

```json
{
  "deployments": [{ "id": "d_2", "status": "success", "createdAt": "2026-10-20T00:00:00Z" }]
}
```

## The refusals

Every refusal carries a fixed code, one sentence that says what was refused, and the evidence
it was refused on:

| Code                                            | What it refuses                                               |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `RAILWAY_PRODUCTION_SOURCE_UNREADABLE`          | the repository declares no production source that can be read |
| `RAILWAY_PRODUCTION_SOURCE_INVALID`             | the declaration is not shaped as a declaration                |
| `RAILWAY_PRODUCTION_TARGET_MISSING`             | no production target is named                                 |
| `RAILWAY_PRODUCTION_TARGET_AMBIGUOUS`           | more than one production target is named                      |
| `RAILWAY_PRODUCTION_TARGET_CONTRADICTORY`       | the live target contradicts the declaration                   |
| `RAILWAY_PRODUCTION_METADATA_MISSING`           | the deployment does not publish the required metadata         |
| `RAILWAY_PRODUCTION_METADATA_CONTRADICTORY`     | the deployment contradicts the pinned metadata                |
| `RAILWAY_PRODUCTION_HISTORY_MISSING`            | the deployment history is empty                               |
| `RAILWAY_PRODUCTION_HISTORY_UNHEALTHY`          | the newest deployment is not in service                       |
| `RAILWAY_PRODUCTION_COMMAND_FAILED`             | a read failed                                                 |
| `RAILWAY_PRODUCTION_COMMAND_TIMED_OUT`          | a read timed out                                              |
| `RAILWAY_PRODUCTION_COMMAND_RUNNER_UNAVAILABLE` | no command runner was supplied, so no live read was made      |
| `RAILWAY_PRODUCTION_READ_UNPARSABLE`            | a read did not parse as JSON                                  |

The evidence is hashed with SHA-256 over the code, the sentence and the evidence itself, so a
receipt can name the refusal it saw without repeating the whole payload, and the same input
always produces the same digest. A deployment is in service when its status is `success`,
`running` or `active`; every other status, including `stopped` and `error`, is refused.

A refusal is the plan working. A production target that is ambiguous, a deployment whose
metadata contradicts what the repository pins, a history whose newest deployment is not in
service and a read that failed are all states in which the honest answer is that the
production source is not established.

## The evidence in this repository

The offline tests live in `tests/railway-production-plan.test.mjs` and run against a fake
command runner only:

```sh
bun test tests/railway-production-plan.test.mjs
```

They cover the planned path, an ambiguous declaration and an ambiguous live read, a missing
target, a contradictory target and a target outside the production environment, missing and
contradictory deployment metadata, a stopped, an errored and an empty history, a failed
command, a timed-out command, a runner that throws, a read that is not JSON, a plan without a
runner, a declaration that is not shaped as one, and the determinism of the plan and of the
evidence digest.

This repository has no root `tests/` directory, so no CI lane runs that file yet: the
orchestration graph's workspaces are `apps/` and `packages/`, and the coverage lane names
`scripts/*.test.ts` explicitly. Wiring the test needs one path in the coverage lane, or a
move to `scripts/railway-production-plan.test.ts`, which is the convention this repository
already uses for the test of a script.

## What this plan does not establish

- It does not establish that the Railway production deployment exists, is healthy or is the
  one the repository means. It establishes only that the declaration and the live read agree.
- It does not establish a cutover, a rollback, a promotion or a recovery. Those are separate
  approved changes with their own receipts.
- It does not establish what the deployment metadata says about the running release beyond
  what the read published, and it publishes nothing about a deployment it could not read.
- It does not record provider identifiers, credentials or endpoints, and it never writes them.
