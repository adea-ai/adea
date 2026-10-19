# Railway cost week

This plan defines the seven-day cost measurement that follows a Railway cutover. It is a
plan, not a measurement: no cutover has been performed, no cost week has started, and no
cost figure is recorded here.

The cutover it follows is described in [Railway cutover checklist](railway-cutover-checklist.md).

The live cutover was approved by the user in conversation. This plan neither grants nor
revokes that approval and is not a substitute for it. The cost week still depends on the
qualification and on each per-action gate in the checklist, and the week does not begin
until the cutover is verified.

## The gate

The cost week starts only after a **verified cutover**. Before that receipt exists:

- no day of the week is counted, and a partial week is not a week;
- the Cloudflare figures below are the pre-cutover record only, and they are not a
  baseline: they cover 130 minutes, they straddle a deployment, and billed CPU and
  representative attribution are unqualified (see
  [Cloudflare organic-traffic evidence](#cloudflare-organic-traffic-evidence));
- no Railway figure has been read. This repository does not hold a live inventory, so
  whether a Railway deployment of the auth service exists is not established here;
- no cost difference may be stated, estimated or implied from any of these figures.

The gate is satisfied by a receipt that names the cutover head, the deployed version, the
observation window after the switch, and the checks that passed. A passing local
acceptance receipt does not satisfy it. Neither does a deployment that has not been
observed.

## What is measured

The cutover moves the **auth database** only. The Worker keeps serving every route, so
Workers requests, billed CPU time and subrequests continue afterwards, and the Cloudflare
side of the comparison does not go to zero. The comparison is therefore between two
**totals**, not between two line items.

| Total                      | Window                                      | Contains                                                                                                    | Read from                                                                      |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Continuing Worker charges  | each counted day, after the cutover         | All Workers requests, billed CPU time and subrequests for the whole app, including the `/api/auth/*` path   | Cloudflare account analytics                                                   |
| Railway charges            | the same counted day, after the cutover     | Managed PostgreSQL storage, compute and connection time, and network egress for the auth database           | Railway project usage and billing console for the project that owns the target |
| Legacy comparable baseline | a historical window from before the cutover | The same Worker charges for that window, plus the Neon charges for the auth database while it lived on Neon | Cloudflare account analytics, and the Neon billing record for that period      |

Cloudflare CPU and subrequests on one side against a Railway database charge on the
other are not substitutes and must not be compared as if they were. The Railway figure
is an addition to a continuing Worker figure, not a replacement for it.

The **same-window** requirement applies to the two post-cutover totals. Continuing
Cloudflare charges and Railway charges must cover the same 24-hour window, because they
are additive and are read as one total. A cost figure without the traffic volume beside
it is not a cost figure; record requests and the failed-request count next to every cost
number so the reader can divide one by the other.

The **legacy comparable baseline** is different in kind. It is a historical window from
before the cutover, so it cannot cover the same calendar window, and it is not required
to. It is identified by its own bounds and **traffic-normalized**: its charges are
expressed per request, and per failed request where the failure rate differs from the
post-cutover window, so that the normalized baseline and the post-cutover total describe
comparable traffic. Comparing unnormalized totals from two windows of different traffic
is not a comparison, and the normalization factor is recorded next to the figures.

This is an auth-database comparison. It does not complete the wider Adea/Control Plane
database migration, which spans more than one database and carries its own runbooks for
the Control Plane service in its own repository. A cost week here is an input to the
auth-database decision, not to the wider migration decision.

## Cloudflare organic-traffic evidence

Everything in this section is already recorded in this repository. Nothing was queried
live for this plan, and no live figure is presented as current.

### What is recorded

**Rolling 24-hour counters, as of 2026-10-18T15:20:00Z.**
Source: `docs/evidence/worker-cpu-local-profiling-2026-10-18.json` (commit `f046c5636`,
2026-10-18, #1462), field `productionTelemetryProvidedByCoordinator`.

| Field                      | Value                                  |
| -------------------------- | -------------------------------------- |
| Rolling 24h invocations    | 1186                                   |
| Rolling 24h CPU overruns   | 307                                    |
| Last observed exceeded CPU | 2026-10-17T16:56:06.704Z               |
| Last failed route          | `account/summary`                      |
| Last failed version        | `ff34a1a5-0309-47d5-9ad6-5c414b90e96d` |
| Latest deployment requests | 28                                     |

The same file records its own conclusion: "Sparse and non-comparable samples do not
establish recovery or current deployment failure." The counters were provided by the
coordinator; they were not independently read for this plan.

**Deployment windows on 2026-10-17.** Source:
`docs/evidence/toolchain-cache-campaign-2026-10-17.json` (commit `5c20ff27f`, 2026-10-17,
#1454), fields `cloudflare` and `currentCheckpoint.cloudflare`.

| Window (UTC)                 | Minutes | Requests | Success | Failed                | Raw CPU                        | Subrequests  | Hyperdrive groups |
| ---------------------------- | ------- | -------- | ------- | --------------------- | ------------------------------ | ------------ | ----------------- |
| 16:45-17:00 (pre-deployment) | 15      | 112      | 30      | 82 exceeded resources | P50 10000, P99 15942 API units | not recorded | not recorded      |
| 17:15-17:30                  | 15      | 1        | 1       | 0                     | not recorded                   | not recorded | 0                 |
| 18:35-20:15                  | 100     | 6        | 6       | 0                     | P50 26282, P99 46191 raw       | 36           | none              |

The three windows total **130 minutes** and 119 requests. The 18:35-20:15 window
**crosses the 19:45:13.79466Z deployment**, so it spans two deployed versions and is
not single-version evidence. The ledger's own reading of the middle row: "Insufficient
to establish recovery or zero load. Missing telemetry does not prove recovery." The
later window carries six invocations and an empty query-group list, and
`recoveryConfirmed` is `false`.

Deployment lineage: deployed source
`287303f13dfea2731b94b5af6936f9a8b9492b49`, run
<https://github.com/adea-ai/adea/actions/runs/39063656595>, deployment
`335f2f14-b48f-485c-a06b-7631cc177205`, worker version
`6c455a6a-8b8d-4092-95aa-2c327eb50147`, deployed 2026-10-17T19:45:13.79466Z at 100%
traffic. The earlier pre-deployment window's lineage is run
<https://github.com/adea-ai/adea/actions/runs/39052654307>, job `117454196301`.

Production **raw** CPU percentiles therefore exist for two of the three windows, and
one of them straddles a deployment. Billed CPU and representative per-route attribution
remain unqualified. The configuration recorded in this repository is not a live deployed
inventory: it does not establish which bindings or services were actually live in any
window.

### What is not established

- **Billed Cloudflare CPU time.** Production **raw** CPU percentiles exist for two of
  the three recorded windows above, and one of those windows straddles a deployment. Raw
  percentiles are not the billed CPU figure, and billed CPU is not established here. The
  CPU figures that were _measured_ in this repository are separate and local: the
  profiling evidence states its CPU method as "OS `proc_pid_rusage` v2 user+system Mach
  ticks multiplied 125/3ns, aggregate isolated runtime and local proxy; **not Cloudflare
  billed CPU**", and its traffic method as "Sequential synthetic one-developer guest
  workspace, one project, one conversation, 12 messages". Those local figures are not an
  organic baseline and are not used as one.
- **Per-route CPU and subrequest attribution.** The campaign ledger lists "Post-rollout
  health and route-level CPU/subrequest attribution" as remaining.
- **Hyperdrive query and cache attribution.** The ledger lists "Hyperdrive
  query/cacheability attribution" as remaining, and the profiling evidence states "SQL
  counts are not Hyperdrive billing". The recorded Hyperdrive group counts are zero and
  none; no Hyperdrive query baseline exists.
- **Any single traffic volume.** The three windows above cover 130 minutes in total, on
  different deployments, with 119 requests between them, and one of them straddles a
  deployment. They are not a traffic baseline.
- **The deployed inventory.** The configuration in this repository is not a live deployed
  inventory. It does not establish which bindings, secrets, Railway services or database
  endpoints were actually live in any recorded window.

### Live read: blocked on the route that was tried

The live Cloudflare read was attempted through one route only, the local `wrangler` CLI
credential, and that route is blocked:

| Check                                              | Result                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route attempted                                    | the `wrangler` OAuth token in the operator's `~/.wrangler/config/default.toml`, recorded as expiring 2026-10-07T20:45:08.543Z                                              |
| Read-only probe                                    | `GET https://api.cloudflare.com/client/v4/accounts` with that token, 2026-10-19                                                                                            |
| Result                                             | **HTTP 403**, Cloudflare error code `9109`, "Invalid access token"                                                                                                         |
| No Cloudflare CLI on `PATH`                        | neither `wrangler` nor `cf` was on `PATH` when the check was made                                                                                                          |
| No credential in the environment or the repository | no `CLOUDFLARE_*` or `CF_*` variable is set; no repository `.env` exists; no workflow in `.github/workflows/` references `api.cloudflare.com` or a GraphQL analytics query |

The scope of that result is exactly the route that was tried. It shows that this local
CLI credential route cannot read the API. It does **not** show that every other
authorized route to the same data is unavailable, and it does not show that any
additional permission would be needed on another route. Another route, including a
dashboard session or a connector, may be authorized where this one is not, and this
document makes no claim about it. Re-authorizing the CLI credential is a credential
change that these documents neither perform nor prescribe.

Separately, root's own connector account-discovery read was policy-blocked. That is a
fact about that read, not a statement about what the account contains, and no live
telemetry has been verified from it. Nothing here asserts that live metrics were found,
or that none exist.

**Live Cloudflare CPU, subrequest and Hyperdrive evidence is therefore not available
through the route that was tried.** The recorded evidence above is the whole of what
this repository holds, and it is not a baseline for a cost comparison.

## The seven days

Once the gate is satisfied:

- [ ] Day 0 is the cutover day itself and is not counted. The first counted day is the
      first full 24-hour UTC window after the cutover.
- [ ] Each day uses the same 24-hour UTC window, so the seven days are comparable with
      each other.
- [ ] For each day, record the Railway figures, the Cloudflare figures, the request
      count, the failed-request count, the subrequest count, and the Hyperdrive query
      count for that same post-cutover window, with the exact window bounds in UTC.
- [ ] Identify the historical legacy baseline window separately, with its own bounds, and
      record the traffic-normalization factor used against it. It is not read on the same
      days as the week, because it precedes the cutover.
- [ ] Record the deployment or version identifier in force that day. A day that spans a
      deployment is recorded as spanning it, not as belonging to either version.
- [ ] Read the figures the same way every day. Changing the method mid-week makes the
      days incomparable, and an incomparable week is not a week.
- [ ] Use organic traffic only. No synthetic request, no load probe, no health check
      aimed at the deployment for measurement purposes.
- [ ] Record a blank or a failure as a blank or a failure. A day with no data is a gap
      in the week, not a zero.
- [ ] A day is counted only when both post-cutover sides, Cloudflare and Railway, were
      read for the same window. A week with a Cloudflare day and a missing Railway day is
      not a cost week.

## Acceptance of the cost week

The week is complete when seven consecutive daily records exist, each with both
post-cutover sides read for the same window, and each naming the version in force. The
report then states:

- the seven-day continuing Cloudflare total and the seven-day Railway charge, with the
  seven-day request and failure counts beside them;
- the identified legacy baseline window, its traffic-normalization factor, and the
  normalized baseline the post-cutover total is compared against;
- the auth path's share of the Cloudflare side, and how it changed across the week;
- every gap, every day that spanned a deployment, and every day whose figures were read
  differently from the others;
- what the week does **not** show. A cost week measures cost. It does not establish
  performance, recovery, correctness, or that the cutover was safe, and it must not be
  cited for any of those.

A completed cost week is an input to a hosting decision. It is not the decision, and it
does not retire Neon, which stays recoverable until a separate approved change says
otherwise.
