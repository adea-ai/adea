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
`.railway/production-source.d.ts` is its type. The declaration records four things:

| Field              | What it states                                                                        |
| ------------------ | ------------------------------------------------------------------------------------- |
| `environment`      | the environment production traffic runs in                                            |
| `targets`          | the candidate production targets; one is a plan, none is a refusal, more is ambiguous |
| `requiredMetadata` | the deployment metadata every production deployment must publish                      |
| `pinnedMetadata`   | the metadata values the repository pins, by field                                     |

The declaration pins the provider identity of the production target: every candidate names the
Railway **project** and the Railway **service** it means, and a candidate that names neither is
not shaped as a declaration and is refused.

An environment is not an identity. One environment holds many services, so a declaration that
named only an environment could not say which service a plan meant, and a live read that named
only an environment could have been planned against any service in it. The identity is recorded
here as **deployment configuration**, which is exactly what it is: the rule in
[Diagram sources](../architecture/diagram-sources.md) holds — a provider resource name is
deployment configuration and not a domain identifier — and this declaration records deployment
configuration deliberately, so that the live read has something concrete to agree with.

The identity in the declaration is the identity the repository _believes_. It is not verified
here: this plan reaches no provider and reads no console. It is a pin, and the plan treats it as
one. A live read that names another project or another service is a refusal
(`RAILWAY_PRODUCTION_TARGET_CONTRADICTORY`), so a wrong identity in the declaration can stop a
plan but can never let one through.

What the repository records beyond the identity is the shape of a production deployment, not the
identifiers of one. A release, an image digest, a region or a promotion time belongs in the
receipt of the change that produced it, not in the source tree, so `pinnedMetadata` is empty
today.

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
provider's schema: nothing here proves what `railway status --json` actually prints. They prove
what the plan does with a read that has been normalized into the documented shape, and the
boundary above is what stops an unnormalized provider payload from being read as one. Validating
the adapter against an authoritative provider schema is a separate piece of work that would need
a recorded provider capture; this document does not claim it.

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
  "deployments": [
    {
      "id": "d_2",
      "project": "adea",
      "service": "auth",
      "status": "success",
      "createdAt": "2026-10-20T00:00:00Z"
    }
  ]
}
```

Every deployment in the history names the project and the service it belongs to. That is the
binding: the history is only the history of the target that was read if each of its deployments
says so. A deployment that names no identity is **unbound**
(`RAILWAY_PRODUCTION_HISTORY_UNBOUND`) and a deployment that names another project or another
service belongs to another target (`RAILWAY_PRODUCTION_HISTORY_CONTRADICTORY`). Either is a
refusal, because a plan that cannot tie its history to its target has not established anything.

## The refusals

Every refusal carries a fixed code, one sentence that says what was refused, and the evidence
it was refused on:

| Code                                            | What it refuses                                               |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `RAILWAY_PRODUCTION_SOURCE_UNREADABLE`          | the repository declares no production source that can be read |
| `RAILWAY_PRODUCTION_SOURCE_INVALID`             | the declaration is not shaped as a declaration                |
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

They cover the planned path, an ambiguous declaration and an ambiguous live read, a missing
target, a contradictory target, a target outside the production environment, a target that
names no project and no service, a declaration whose target names neither, a history that
binds no deployment to the target, a history that belongs to another project and a history that
belongs to another service, missing and contradictory deployment metadata, a stopped, an errored
and an empty history, a failed command, a timed-out command, a runner that throws, a read that
is not JSON, a read that is not the normalized read the plan reads, a plan without a runner, a
declaration that is not shaped as one, and the determinism of the plan and of the evidence
digest.

## What this plan does not establish

- It does not establish that the Railway production deployment exists, is healthy or is the
  one the repository means. It establishes only that the declaration and the live read agree.
- It does not establish that the project and service the declaration names are the right ones.
  It establishes that the live read agrees with the declaration; only an owner who can see the
  provider can establish that the declaration names the production target at all.
- It does not establish what the provider's own JSON looks like. It establishes that the reads
  it is given are the normalized shape documented above.
- It does not establish a cutover, a rollback, a promotion or a recovery. Those are separate
  approved changes with their own receipts.
- It does not establish what the deployment metadata says about the running release beyond
  what the read published, and it publishes nothing about a deployment it could not read.
- It does not record provider identifiers, credentials or endpoints, and it never writes them.
