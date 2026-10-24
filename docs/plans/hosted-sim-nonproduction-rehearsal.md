# Hosted Agent Sim: non-production rehearsal plan

Status: plan only. Nothing here has been run, created or authorized. Every step below that touches
Cloudflare, DNS, a database, a credential or storage needs its own authorization that names the
step. A decision to plan the rehearsal (G7) is not that authorization.

## Purpose

Prove the live half of the hosted Agent Sim once, on scratch resources that are removed afterwards,
before anything is considered for production. The rehearsal answers the live acceptance items L1 to
L10 of the readiness plan. It uses no production data and no real customer workspace.

## Scope and limits

- One scratch Worker on one scratch hostname, distinct from the app's cookie host.
- One test workspace on the allowlist (G1), one surface at a time.
- Scratch storage for the private export and a scratch database. No production database and no
  production schema change.
- Adea-owned assets only (`scenes/sim/assets/`). The third-party packs stay withheld (G4).
- A named teardown owner and a time limit, set before the first step.

## Preconditions (all source work, no live step)

1. The inert Worker entry exists and fails closed with no composition.
2. The allowlist policy exists with its lookup port.
3. The private reader withholds the third-party prefixes.
4. The export layout has been compared with the provenance record, so no withheld pack reaches the
   scratch location by another path.

## Steps, in order, each separately authorized

| #   | Step                                                                                               | Gated as                         | Teardown                           |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------- |
| 1   | Create the scratch database and apply `0059_sim_launch_sessions.sql` and the allowlist table to it | schema change, scratch only      | drop the database                  |
| 2   | Create a least-privilege role for the Sim host on that database                                    | credential                       | drop the role                      |
| 3   | Create the scratch private location, upload the Adea-owned export, set the ACL                     | asset upload, access change      | delete objects, then the location  |
| 4   | Confirm no public alias for the same objects                                                       | read-only check                  | none                               |
| 5   | Create the scratch Worker with the bindings from steps 1 to 3 and a composition for it             | deployment, binding              | delete the Worker                  |
| 6   | Create the scratch hostname and DNS record                                                         | DNS                              | delete the record                  |
| 7   | Add one test workspace row to the allowlist and set `ADEA_SIM_ORIGIN` on a non-production app      | entitlement grant, configuration | delete the row, unset the variable |
| 8   | Run L1 to L10                                                                                      | live acceptance                  | evidence kept, resources torn down |

## Evidence to keep

For each live item: the exact request, the status, the headers that matter (`cache-control`,
cookie attributes, `referrer-policy`), a hash of any body, and the time. No credential, token or
cookie value goes into a record. The denial matrix must show that a denied launch created no code
and that a denied asset request read nothing from storage.

## Teardown and abort

Teardown runs in reverse order and is complete only when each resource is confirmed gone by a
read-only check. The rehearsal aborts at the first unexpected public alias, unexpected cost, or
denied request that served bytes. An abort goes straight to teardown, and nothing is repaired in
place.

## What a clean rehearsal does not prove

It does not authorize production. Production still needs its own decision for each step above,
the counsel answer on the third-party packs if they are to render, and the production database and
hostname choices.
