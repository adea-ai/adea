# Railway production source plan

The plan answers one question: what is the production target right now, and is that answer
good enough to act on? It answers it from two sources — the repository's own declaration in
`.railway/production-source.js` and a live read of the deployment — and it refuses rather than
guess.

The plan is a read. It authorizes nothing: it does not provision, deploy, cut over, promote,
migrate, change a credential, or mutate production. The cutover itself is described in
[Railway cutover checklist](railway-cutover-checklist.md), the recovery that reverses it in
[Railway PostgreSQL recovery](railway-postgres-recovery.md), and the cost measurement that
follows a verified cutover in [Railway cost week](railway-cost-week-plan.md). This document
describes only the plan that says which production target the repository believes it has.

## The declaration

`.railway/production-source.js` is the repository's declaration of its production source, and
`.railway/production-source.d.ts` is its type. The declaration records five things:

| Field              | What it states                                                                        |
| ------------------ | ------------------------------------------------------------------------------------- |
| `configured`       | whether this repository has configured a production identity                          |
| `environment`      | the environment production traffic runs in                                            |
| `targets`          | the candidate production targets; one is a plan, none is a refusal, more is ambiguous |
| `requiredMetadata` | the deployment metadata every production deployment must publish                      |
| `pinnedMetadata`   | the metadata values the repository pins, by field                                     |

**The production identity is not configured in this repository, and the declaration says so
rather than guessing one.** `configured` is `false`, no target is named, and the plan refuses with
`RAILWAY_PRODUCTION_SOURCE_UNCONFIGURED` — before making any live read, because there is no
declared target for a read to agree with.

That is the honest state, and the repository's own documents say why:

- a Railway project and service are provider configuration rather than domain identifiers, and
  this repository does not record them ([Diagram sources](../architecture/diagram-sources.md));
- [Railway cost week](railway-cost-week-plan.md) records that whether a Railway deployment of
  the auth service exists is **not established**;
- [Railway cutover checklist](railway-cutover-checklist.md) records that this repository holds no
  live deployment inventory.

So a declaration naming a project or a service would be a claim the repository cannot stand
behind, and a plan that agreed with a claim would be worth nothing. Nothing can be planned until
an owner who can see the Railway console records the identity.

The machinery that checks a recorded identity is already in place, and the offline suite
exercises it:

| Rule                                    | What it refuses                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| a candidate names a project and service | a candidate that names neither is not shaped as a declaration                                                                                   |
| the live target matches the candidate   | a live target that names another project or service is a contradiction                                                                          |
| the history is bound to that target     | a deployment that names no identity is unbound; one naming another project, another service or another environment is not this target's history |

An environment alone is not an identity. One environment holds many services, so a declaration
that named only an environment could not say which service a plan meant, and a live read that
named only an environment could have been planned against any service in it. When the identity is
recorded it will be recorded as **deployment configuration**, which is exactly what it is: the
rule in [Diagram sources](../architecture/diagram-sources.md) holds — a provider resource name is
deployment configuration and not a domain identifier — and the plan will treat the recorded value
as a pin, refusing a live read that disagrees with it.

What the repository records today is the shape of a production deployment, not the identifiers of
one. A release, an image digest, a region or a promotion time belongs in the receipt of the
change that produced it, not in the source tree, so `pinnedMetadata` is empty today.

## The live reads

The plan needs two reads of the deployment, and it names both:

| Read          | Command it describes             | Normalized shape it is read as    | What it establishes                               |
| ------------- | -------------------------------- | --------------------------------- | ------------------------------------------------- |
| `status`      | `railway status --json`          | `{ targets: [], deployment: {} }` | the production target and its deployment metadata |
| `deployments` | `railway deployment list --json` | `{ deployments: [] }`             | the deployment history, newest first              |

The plan itself runs no command. The caller injects a command runner, and the runner is the
only thing that can reach the deployment:

```js
const { planProductionDeployment } = await import('./scripts/railway-production-plan.mjs')

const plan = planProductionDeployment({
  run: (request) => ({ status: 0, stdout: readSomehow(request.command), stderr: '' }),
})
```

The runner receives the kind of the read, the command it describes and the timeout to apply,
and answers with `{ status, stdout, stderr }`, or `{ timedOut: true } when it gave up, or
throws when it could not start. A plan without a runner is a refusal, never an empty plan: the
plan module imports no child process, starts nothing and reaches no network of its own.

## The normalization boundary

**The plan reads a normalized projection of the provider's JSON, not the provider's JSON
itself.** The boundary is explicit and it is enforced:

- The **runner** owns the mapping. It reads the provider's own output and normalizes it into the
  shape named in the table above. The plan does not know, and does not care, what the provider's
  raw payload looks like.
- The **plan** checks that the payload it is handed _is_ that shape: the containers each read
  carries are present, each container has the right type, and every entry in a list is an
  object. A payload that is not the normalized shape is refused with
  `RAILWAY_PRODUCTION_READ_UNNORMALIZED`, naming every problem it found.
- The **content** of a container is the plan's business, not the shape's: whether a target names
  a concrete project and service, whether the deployment publishes the required metadata, and
  whether the history belongs to the target are all rules of the plan, applied after the shape
  has been accepted.

This is why the offline fixtures in `scripts/railway-production-plan.test.ts` are **normalized
fixtures**. They are not captured Railway CLI output and they are not a claim about the
provider's schema: nothing here proves what `railway status --json` actually prints. The identity
values in them are **placeholders** — `example-project` and `example-service` — because the
repository has configured no production identity and a fixture that looked like a recorded one
would suggest otherwise. They prove what the plan does with a read that has been normalized into
the documented shape, and the boundary above is what stops an unnormalized provider payload from
being read as one. Validating the adapter against an authoritative provider schema is a separate
piece of work that would need a recorded provider capture; this document does not claim it.

The adapter side of that boundary is a contract of its own:
[`railway-production-source-contract.md`](railway-production-source-contract.md) names the
public, non-secret schema provenance the adapter normalizes against, the two read shapes, and
the mapping from the provider's field names to the ones the plan reads, and it is proven
against the planner itself by `scripts/railway-production-source-contract.test.ts`. That
provenance is a citation of the published schema, **not** a captured provider payload: the
contract records `capturedProviderOutput: false` and `identityEvidence: none`, so nothing in
it may be read as live provider acceptance, and the identity values in its fixtures are
placeholders.

The reads are JSON, and the plan refuses a read it cannot parse rather than plan on a payload
it did not understand. A status read answers with the candidate targets and the deployment
metadata; a deployments read answers with the deployment history, newest first. The identity
values below are placeholders:

```json
{
  "targets": [
    { "project": "example-project", "service": "example-service", "environment": "production" }
  ],
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
  "deployments": [
    {
      "id": "d_2",
      "project": "example-project",
      "service": "example-service",
      "environment": "production",
      "status": "success",
      "createdAt": "2026-10-20T00:00:00Z"
    }
  ]
}
```

Every deployment in the history names the project, the service **and the environment** it belongs
to. That is the binding: the history is only the history of the target that was read if each of
its deployments says so, on all three.

The environment is part of the binding, not a detail of it. The same project and the same service
exist in more than one environment, so a history staged in another environment names the same
project and the same service and is still not the history of this target. A deployment that names
no identity is **unbound** (`RAILWAY_PRODUCTION_HISTORY_UNBOUND`) and a deployment that names
another project, another service or another environment belongs to another target
(`RAILWAY_PRODUCTION_HISTORY_CONTRADICTORY`). Either is a refusal, because a plan that cannot tie
its history to its target has not established anything.

## The refusals

Every refusal carries a fixed code, one sentence that says what was refused, and the evidence
it was refused on:

| Code                                            | What it refuses                                               |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `RAILWAY_PRODUCTION_SOURCE_UNREADABLE`          | the repository declares no production source that can be read |
| `RAILWAY_PRODUCTION_SOURCE_INVALID`             | the declaration is not shaped as a declaration                |
| `RAILWAY_PRODUCTION_SOURCE_UNCONFIGURED`        | the repository has configured no production identity          |
| `RAILWAY_PRODUCTION_TARGET_MISSING`             | no production target is named                                 |
| `RAILWAY_PRODUCTION_TARGET_AMBIGUOUS`           | more than one production target is named                      |
| `RAILWAY_PRODUCTION_TARGET_IDENTITY_MISSING`    | the live target names no project and no service               |
| `RAILWAY_PRODUCTION_TARGET_CONTRADICTORY`       | the live target contradicts the declaration                   |
| `RAILWAY_PRODUCTION_METADATA_MISSING`           | the deployment does not publish the required metadata         |
| `RAILWAY_PRODUCTION_METADATA_CONTRADICTORY`     | the deployment contradicts the pinned metadata                |
| `RAILWAY_PRODUCTION_HISTORY_MISSING`            | the deployment history is empty                               |
| `RAILWAY_PRODUCTION_HISTORY_UNHEALTHY`          | the newest deployment is not in service                       |
| `RAILWAY_PRODUCTION_HISTORY_UNBOUND`            | the history does not bind its deployments to the target       |
| `RAILWAY_PRODUCTION_HISTORY_CONTRADICTORY`      | the history belongs to another target                         |
| `RAILWAY_PRODUCTION_COMMAND_FAILED`             | a read failed                                                 |
| `RAILWAY_PRODUCTION_COMMAND_TIMED_OUT`          | a read timed out                                              |
| `RAILWAY_PRODUCTION_COMMAND_RUNNER_UNAVAILABLE` | no command runner was supplied, so no live read was made      |
| `RAILWAY_PRODUCTION_READ_UNPARSABLE`            | a read did not parse as JSON                                  |
| `RAILWAY_PRODUCTION_READ_UNNORMALIZED`          | a read is not the normalized read the plan reads              |

The evidence is hashed with SHA-256 over the code, the sentence and the evidence itself, so a
receipt can name the refusal it saw without repeating the whole payload, and the same input
always produces the same digest. A deployment is in service when its status is `success`,
`running` or `active`; every other status, including `stopped` and `error`, is refused.

A refusal is the plan working. A production target that is ambiguous, a target that names no
service, a deployment whose metadata contradicts what the repository pins, a history that is not
the target's history, a history whose newest deployment is not in service and a read that
failed are all states in which the honest answer is that the production source is not
established.

## The evidence in this repository

The offline tests live in `scripts/railway-production-plan.test.ts` and run against a fake
command runner only:

```sh
bun test scripts/railway-production-plan.test.ts
```

That path is the repository's convention for the test of a script, and it is the path the
canonical coverage lane discovers: `bun run test:coverage` runs `bun test … scripts/*.test.ts
--coverage`, so the file is selected by the normal CI selection with no lane-specific
configuration and no separate registration.

They cover the planned path, a declaration that has not configured a production identity, a
declaration whose configured flag is not a boolean, an ambiguous declaration and an ambiguous live
read, a missing target, a contradictory target, a target outside the production environment, a
target that names no project and no service, a declaration whose target names neither, a history
that binds no deployment to the target, a history whose deployment names no environment, a history
staged in another environment, a history that belongs to another project and a history that
belongs to another service, missing and contradictory deployment metadata, a stopped, an
errored and an empty history, a failed command, a timed-out command, a runner that throws, a read
that is not JSON, a read that is not the normalized read the plan reads, a plan without a runner,
a declaration that is not shaped as one, and the determinism of the plan and of the evidence
digest.

The shipped declaration is covered as well, and it is covered as what it is: the repository has
configured no production identity, so the plan against the repository's own declaration refuses
and makes no live read.

## What this plan does not establish

- It does not establish that the Railway production deployment exists, is healthy or is the
  one the repository means. It establishes only that the declaration and the live read agree.
- It does not establish the production identity, because the repository has not configured one.
  It establishes that the declaration says so, and it refuses rather than planning against a
  guessed identity. Only an owner who can see the provider can record the identity.
- It does not establish what the provider's own JSON looks like. It establishes that the reads
  it is given are the normalized shape documented above, and its fixtures are normalized
  fixtures with placeholder identity values.
- It does not establish a cutover, a rollback, a promotion or a recovery. Those are separate
  approved changes with their own receipts.
- It does not establish what the deployment metadata says about the running release beyond
  what the read published, and it publishes nothing about a deployment it could not read.
- It does not record provider identifiers, credentials or endpoints, and it never writes them.
