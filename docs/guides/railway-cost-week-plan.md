# Railway cost week

This plan defines the seven-day cost measurement that follows a Railway cutover. It is a
plan, not a measurement: no cutover has been performed, no cost week has started, and no
cost figure is recorded here.

The cutover it follows is described in [Railway cutover checklist](railway-cutover-checklist.md).

## The gate

The cost week starts only after a **verified cutover**. Before that receipt exists:

- no day of the week is counted, and a partial week is not a week;
- the Cloudflare figures below are the pre-cutover baseline only, and they are
  themselves incomplete (see [Cloudflare organic-traffic evidence](#cloudflare-organic-traffic-evidence));
- the Railway side has no baseline at all, because no Railway deployment of the auth
  service exists yet;
- no cost difference may be stated, estimated or implied from the two sides.

The gate is satisfied by a receipt that names the cutover head, the deployed version, the
observation window after the switch, and the checks that passed. A passing local
acceptance receipt does not satisfy it. Neither does a deployment that has not been
observed.

## What is measured

| Side       | Measure                                                                                                                        | Source                                                                         | Read by                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------- |
| Railway    | Managed PostgreSQL storage, compute and connection time, and network egress for the auth database, for the same 24-hour window | Railway project usage and billing console for the project that owns the target | Operator, from a Railway account session    |
| Cloudflare | Workers requests, billed CPU time, subrequests, and Hyperdrive queries for the same window                                     | Cloudflare account analytics (dashboard or GraphQL Analytics)                  | Operator, from a Cloudflare account session |

Both columns must be read for the **same** window, from the same production traffic. A
cost figure without the traffic volume beside it is not a cost figure; record requests
and the failed-request count next to every cost number so the reader can divide one by
the other.

The cutover changes where the auth database lives, not the app's traffic. The comparison
that matters is therefore the auth path's share of each side: the Cloudflare CPU and
subrequest cost of serving `/api/auth/*` against a Neon-backed database, versus the
Railway cost of the database that replaces it, for the same organic requests.

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

| Window                       | Requests | Success | Failed                | CPU                            | Subrequests  | Hyperdrive groups |
| ---------------------------- | -------- | ------- | --------------------- | ------------------------------ | ------------ | ----------------- |
| 16:45-17:00 (pre-deployment) | 112      | 30      | 82 exceeded resources | P50 10000, P99 15942 API units | not recorded | not recorded      |
| 17:15-17:30                  | 1        | 1       | 0                     | not recorded                   | not recorded | 0                 |
| 18:35-20:15                  | 6        | 6       | 0                     | P50 26282, P99 46191 raw       | 36           | none              |

The ledger's own reading of the middle row: "Insufficient to establish recovery or zero
load. Missing telemetry does not prove recovery." The later window carries six
invocations and an empty query-group list, and `recoveryConfirmed` is `false`.

Deployment lineage for those windows: deployed source
`287303f13dfea2731b94b5af6936f9a8b9492b49`, run
<https://github.com/adea-ai/adea/actions/runs/39063656595>, deployment
`335f2f14-b48f-485c-a06b-7631cc177205`, worker version
`6c455a6a-8b8d-4092-95aa-2c327eb50147`, deployed 2026-10-17T19:45:13.79466Z at 100%
traffic. The earlier pre-deployment window's lineage is run
<https://github.com/adea-ai/adea/actions/runs/39052654307>, job `117454196301`.

### What is not established

- **Billed Cloudflare CPU time.** The only CPU figures measured in this repository come
  from local fixtures: the profiling evidence states its CPU method as "OS
  `proc_pid_rusage` v2 user+system Mach ticks multiplied 125/3ns, aggregate isolated
  runtime and local proxy; **not Cloudflare billed CPU**", and its traffic method as
  "Sequential synthetic one-developer guest workspace, one project, one conversation, 12
  messages". Synthetic local CPU is not an organic baseline and is not used as one here.
- **Per-route CPU and subrequest attribution.** The campaign ledger lists "Post-rollout
  health and route-level CPU/subrequest attribution" as remaining.
- **Hyperdrive query and cache attribution.** The ledger lists "Hyperdrive
  query/cacheability attribution" as remaining, and the profiling evidence states "SQL
  counts are not Hyperdrive billing". The recorded Hyperdrive group counts are zero and
  none; no Hyperdrive query baseline exists.
- **Any single traffic volume.** The three windows above cover 3.5 hours in total, on
  different deployments, with 119 requests between them. They are not a traffic baseline.

### Live read: blocked

Live Cloudflare analytics could not be read for this plan. The probe and its result:

| Check                           | Result                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Stored credential               | `wrangler` OAuth token in the operator's `~/.wrangler/config/default.toml`, recorded as expiring 2026-10-07T20:45:08.543Z             |
| Recorded scopes                 | `account:read`, `user:read`, `zone:read`, `workers:write`, `workers_tail:read` and others; no account-analytics read scope is present |
| Read-only probe                 | `GET https://api.cloudflare.com/client/v4/accounts` with that token, 2026-10-19                                                       |
| Result                          | **HTTP 403**, Cloudflare error code `9109`, "Invalid access token"                                                                    |
| No Cloudflare CLI               | neither `wrangler` nor `cf` is on `PATH`; no `CLOUDFLARE_*` or `CF_*` variable is set; no repository `.env` exists                    |
| No repository automation for it | no workflow in `.github/workflows/` references `api.cloudflare.com` or a GraphQL analytics query                                      |

The credential is expired, and re-authorizing it is a credential change that this task
does not authorize, so the live read stays blocked. Whoever re-authorizes it must also
grant the account-analytics read scope, or the GraphQL analytics query will fail on
scope rather than on authentication.

**Live Cloudflare CPU, subrequest and Hyperdrive evidence is therefore BLOCKED.** The
recorded evidence above is the whole of what this repository holds, and it is not a
baseline for a cost comparison.

## The seven days

Once the gate is satisfied:

- [ ] Day 0 is the cutover day itself and is not counted. The first counted day is the
      first full 24-hour UTC window after the cutover.
- [ ] Each day uses the same 24-hour UTC window, so the seven days are comparable with
      each other and with the pre-cutover windows.
- [ ] For each day, record the Railway figures, the Cloudflare figures, the request
      count, the failed-request count, the subrequest count, and the Hyperdrive query
      count for the same window, with the exact window bounds in UTC.
- [ ] Record the deployment or version identifier in force that day. A day that spans a
      deployment is recorded as spanning it, not as belonging to either version.
- [ ] Read the figures the same way every day. Changing the method mid-week makes the
      days incomparable, and an incomparable week is not a week.
- [ ] Use organic traffic only. No synthetic request, no load probe, no health check
      aimed at the deployment for measurement purposes.
- [ ] Record a blank or a failure as a blank or a failure. A day with no data is a gap
      in the week, not a zero.
- [ ] A day is counted only when both sides were read for the same window. A week with
      a Cloudflare day and a missing Railway day is not a cost week.

## Acceptance of the cost week

The week is complete when seven consecutive daily records exist, each with both sides
read for the same window, and each naming the version in force. The report then states:

- the seven-day Railway cost and the seven-day Cloudflare cost, with the seven-day
  request and failure counts beside them;
- the auth path's share of the Cloudflare side, and how it changed across the week;
- every gap, every day that spanned a deployment, and every day whose figures were read
  differently from the others;
- what the week does **not** show. A cost week measures cost. It does not establish
  performance, recovery, correctness, or that the cutover was safe, and it must not be
  cited for any of those.

A completed cost week is an input to a hosting decision. It is not the decision, and it
does not retire Neon, which stays recoverable until a separate approved change says
otherwise.
