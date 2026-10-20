# Hosted AgentSim: lane D source verification and composition evidence

Lane: **D — hosted AgentSim (source only)**, Adea only.

- Base: `origin/main` at `333b948d4c5fba1f88d98d764c075b790be6ee22`.
- Branch: `codex/20261020-hosted-sim-w6`.
- Pull request: draft, opened from this branch (see "Publication").
- Environment: macOS 26.7.1 (build 25G241), arm64, Bun 1.4.3, Node v24.21.0.
- Time of the runs below: 2026-10-20, 03:11–03:40 UTC-04 (07:11–07:40 UTC).
- Dependencies: `bun install --frozen-lockfile` against the committed `bun.lock`; no lockfile
  change, no dependency addition.
- Playwright Chromium: `bunx playwright install chromium` installed the pinned browser locally so
  the browser lane could run. No repository file changed for it.

Nothing in this lane deployed anything, chose a hosting destination, created a credential, changed
an access grant or issued a live entitlement.

## 1. The merged work this lane owns is present on main

Each pull request below is an ancestor of `origin/main` at the base above, so the lane's merged
behaviour is on main and not only on a branch.

| PR    | Merge commit                               | Subject                                                                  |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------ |
| #1448 | `40716fcf9fd14ec775684a6b27ea8f251e86629d` | feat(sim): wire hosted surfaces and remove desktop payload               |
| #1485 | `79790737d427a4b7902e733dcfdef3306786370b` | feat(sim): validate the hosted Sim host configuration before serving     |
| #1494 | `432cf58959cbb92c0ee14474ec2834ae7e431d3f` | feat(sim): redeem a launch code and save its session atomically          |
| #1498 | `d8a543de51c12222465bbccbd9a5f0d699c8af7b` | Sim asset gate: take workspace and surface from the stored session       |
| #1505 | `83c413d0f710d97620ec03120665ac92de8b8225` | test(sim): pin fail-closed hosted Sim entitlement and production default |
| #1508 | `e5693d5e33a77d2e1a8bb511a0994fba1a189321` | test(sim): pin per-request fan-out of hosted Sim asset reads             |

Verification commands:

```sh
git rev-parse origin/main
for sha in 40716fcf9 79790737d 432cf5895 d8a543de5 83c413d0f e5693d5e3; do
  git rev-parse "$sha"
  git merge-base --is-ancestor "$sha" origin/main && echo ancestor
done
```

Result: every one of the six merge commits resolved to the full SHA above and reported `ancestor`
of `origin/main` at `333b948d4c5fba1f88d98d764c075b790be6ee22`.

What that merged work already guarantees, and what this lane re-ran:

- The launch is closed without an installed entitlement authority, and a configured hostname alone
  grants nothing (`apps/web/test/sim-api-default.test.ts`).
- The hosted origin validates its configuration before it serves anything, and refuses a parent
  origin on the same cookie host (`apps/web/test/sim-host-config.test.ts`).
- The private asset gate takes the workspace and the surface from the stored session row, never
  from the request (`apps/web/test/sim-asset-gate.test.ts`).
- The launch code is spent by its first presentation and the session is written in the same
  transaction (`packages/db/tests/integration/sim-launch-sessions.test.ts`).

## 2. The gaps this lane closed

The merged work left three named gaps in the production composition proposal, and the plan recorded
them as decisions rather than source:

1. No composition bound the authenticated principal, the workspace authorization and an explicit
   entitlement policy to the durable code store.
2. No composition assembled the separately hosted service from the durable session lookup, the
   entitlement policy and a private asset reader.
3. The private asset location existed only inside a test fixture: there was no source that named
   the private location and kept the read inside it.

This lane adds that source:

- `apps/web/src/server/sim-launch-service.ts` — the launch composition.
- `apps/web/src/server/sim-host-service.ts` — the separately hosted service composition.
- `apps/web/src/server/sim-private-assets.ts` — the named private asset location reader.
- `packages/db/src/sim-launch-ports.ts` — the durable adapters for those ports.

The reader proves the request-side half of the private asset gate: a plain location name, a key
that cannot leave the location, and an object returned instead of an address. It does not prove
anything about the storage access control list, about a public alias the storage provider may
expose for the same objects, or about any other principal that may read them. Those are deployment
prerequisites, and they are listed as such in the approved service composition.

The [approved service composition](../plans/hosted-sim-approved-service-composition.md) records the
interfaces and the decisions root still owns. No policy, origin, storage target or hosting
destination was selected.

## 3. The behaviours the lane had to cover

| Behaviour                                         | Where it is pinned                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| replay of a spent code                            | `apps/web/test/sim-launch-service.test.ts`, `apps/web/test/sim-host-service.test.ts`, `packages/db/tests/integration/sim-launch-sessions.test.ts` |
| concurrent consumption of one code                | `packages/db/tests/integration/sim-launch-sessions.test.ts` (row lock, real PostgreSQL)                                                           |
| expiry of a code and of a session                 | `apps/web/test/sim-launch-service.test.ts`, `apps/web/test/sim-host-service.test.ts`, `packages/db/tests/integration/sim-launch-sessions.test.ts` |
| unauthorized principal, workspace or presentation | `apps/web/test/sim-launch-service.test.ts`, `apps/web/test/sim-host-service.test.ts`                                                              |
| invalid entitlement answer                        | `apps/web/test/sim-launch-service.test.ts`, `apps/web/test/sim-host-service.test.ts`                                                              |
| workspace-authorized but explicitly not entitled  | `apps/web/test/sim-launch-service.test.ts`, `apps/web/test/sim-offload-browser/composition-acceptance.test.ts`                                    |
| storage failure                                   | `apps/web/test/sim-launch-service.test.ts`, `apps/web/test/sim-host-service.test.ts`, `packages/db/tests/integration/sim-launch-sessions.test.ts` |
| private assets absent from the desktop bundle     | `scripts/desktop-sim-payload.test.ts`, `scripts/check-desktop-sim-payload.mjs`                                                                    |

The durable store's transactional behaviour needs a real PostgreSQL, so its replay, concurrency,
expiry and storage-failure cases stay in the database integration suite. The composition cases
cover the same behaviours against in-memory stores, so they run in the ordinary unit lane.

## 4. Private assets are absent from the desktop bundle

The check is wired in two places, and both were confirmed in this lane:

- `apps/desktop/scripts/client.mjs` runs `scripts/check-desktop-sim-payload.mjs --client` over the
  built desktop client.
- `.github/workflows/release-assets.yml` runs `scripts/check-desktop-sim-payload.mjs --archive` over
  the inner installed archive before publication.

```sh
bun test scripts/desktop-sim-payload.test.ts
```

Result: 8 pass, 0 fail, 22 assertions. The suite refuses a stale private pack, refuses binaries
moved out of the former engine prefix, refuses symlinks that could conceal a payload, refuses the
legacy pack configuration without reading or staging private files, and refuses an incomplete
client.

The real desktop client build was run in this lane as well:

```sh
bun apps/desktop/scripts/client.mjs
```

Result: the client built and the payload check that the build runs over
`apps/web/dist-desktop/client` reported `{"files":317,"bytes":4051052,"simPayloadFiles":0}` — the
built desktop client carries no private Agent Sim payload. The archive mode of the same checker
(`--archive`, over the inner installed archive) is covered by the checker suite above and runs in
the release workflow before publication; this lane did not build a release archive.

## 5. The qualified service and the optional view

`apps/web/test/sim-offload-browser/composition-acceptance.test.ts` runs the approved composition on
both sides of the launch against disposable in-memory stores, in a real browser:

- an entitled workspace reaches the optional view and its private entry;
- this service answers `401` for a private asset without a session and `404` under any other
  prefix, so it offers no second route to a private object;
- the sim-only session cookie is the only carrier, and it is `HttpOnly`, `Secure` and
  `SameSite=None`;
- a workspace the principal may read but the entitlement policy does not entitle reaches the
  independent entitlement gate: the policy is consulted about that workspace and surface, and no
  launch code, no session and no private read happen for it;
- a workspace the principal may not read is refused by the membership check, so the policy is
  never asked about it;
- in both refusals the rest of the app stays usable.

The fixture app accepts a `?workspace=` query parameter so these cases can be driven without a
second fixture. The default is unchanged. The fixture's workspace read authorization and its
entitlement policy are separate: an earlier version used one set for both, which made the
not-entitled case fail the membership check before the entitlement policy was ever consulted.

## 6. Commands and results

| Command                                                                                                                                      | Result                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                                                              | 39 packages installed; no lockfile change                                             |
| `bun run build:web-deps`                                                                                                                     | 16/16 tasks successful                                                                |
| `bun test apps/web/test/sim-*.test.ts packages/spatial/test/sim-*.test.ts scripts/desktop-sim-payload.test.ts scripts/docs-boundary.test.ts` | 236 pass, 0 fail, 1026 assertions across 18 files                                     |
| `bun test apps/web/test/sim-offload-browser/acceptance.test.ts`                                                                              | 1 pass, 0 fail, 28 assertions                                                         |
| `bun test apps/web/test/sim-offload-browser/composition-acceptance.test.ts`                                                                  | 1 pass, 0 fail, 26 assertions                                                         |
| `bun apps/desktop/scripts/client.mjs`                                                                                                        | Client built; payload check reported `simPayloadFiles: 0` over 317 files              |
| `bun run format:check`                                                                                                                       | All matched files use the correct format                                              |
| `bun run lint`                                                                                                                               | 0 warnings, 0 errors in every workspace                                               |
| `bun run --cwd apps/web typecheck`                                                                                                           | No type errors in 327 files                                                           |
| `bun run --cwd packages/db typecheck`                                                                                                        | No type errors in 114 files                                                           |
| `bun run test:coverage`                                                                                                                      | 2069 pass, 0 fail; all files 98.36% lines, 97.97% functions — unchanged from the base |
| `bun run test:unit`                                                                                                                          | exit 0; every workspace lane passed                                                   |
| `bun run --cwd packages/db db:migrate` (disposable PostgreSQL)                                                                               | Migration verification passed, 60 migrations applied                                  |
| `DATABASE_URL=… bun test packages/db/tests/integration/sim-launch-sessions.test.ts` (disposable PostgreSQL)                                  | 17 pass, 0 fail, 55 assertions                                                        |

The database-backed suite ran against a disposable PostgreSQL container that this lane started on
`127.0.0.1:55439` with the repository's own `infra/postgres/init` roles and the pinned
`postgres:18-alpine` image (server 18.6), and removed again afterwards. No shared, pre-existing or
live database was used. The receipt of that run is 17 tests, 0 failures, 55 assertions, and the
bounded follow-up below re-ran it unchanged.

### Environment notes

- The coverage lane pulls the pinned `postgres:18-alpine` image for its disposable-postgres
  fixture. A Docker Hub rate limit (`toomanyrequests: Data limit exceeded`) made that lane exit
  non-zero once during this run, with no test failure: 2072 tests passed and 0 failed. One
  `docker pull postgres:18-alpine` restored the local image and the lane then passed with the
  baseline numbers. The gate was not weakened, excluded or reconfigured.
- The coverage threshold is applied per measured file. A first attempt at this lane put a unit
  test for `packages/db/src/sim-launch-ports.ts` in the coverage lane, which pulled the
  database-only `packages/db/src/sim-launch-sessions.ts` into the measured set at 28% and failed
  the gate. The adapter assertions moved to the database integration suite, which owns them, and
  the coverage lane returned to the base numbers above. No threshold, exclusion or coverage
  configuration changed.

## 7. No-Neon proof for the admitted scope

Railway is the sole target. The admitted scope of this lane is the hosted AgentSim source, and it
carries no Neon integration, trace, fallback, compatibility path or rollback:

```sh
grep -rn -i "neon" \
  apps/web/src/server/sim-*.ts apps/web/src/lib/sim-*.ts \
  apps/web/test/sim-*.test.ts apps/web/test/sim-offload-browser/*.ts \
  packages/db/src/sim-launch-*.ts packages/spatial/src/sim-bridge/ \
  docs/guides/hosted-agent-sim.md docs/plans/hosted-sim-*.md
```

Result: no match. The durable launch code and session are ordinary PostgreSQL tables
(`packages/db/drizzle/0059_sim_launch_sessions.sql`) with no provider binding, so the storage
target is a decision the approved service makes, and nothing in this lane preselects one. The
wider Neon removal belongs to the Railway lanes; this is the proof for the admitted scope only.

## 8. What is still blocked

- **Live hosting is blocked and stays blocked.** No hosting destination, hostname, DNS, binding,
  credential, access change or deployment was made or authorized. The production route answers
  `unavailable/not_configured` because it installs no entitlement policy.
- **The entitlement policy is a root decision.** No account policy was chosen and no authenticated
  workspace member was treated as entitled.
- **The durable storage is a root decision.** The `sim_launch_codes` and `sim_sessions` migration
  exists in `packages/db/drizzle/0059_sim_launch_sessions.sql`, but the target database, the
  access and the cleanup of expired rows were not selected.
- **The private storage configuration is a root decision.** The source proves the request-side gate
  — the location name, the key and the bytes. The access control list that makes the location
  private, the absence of a public alias for the same objects, and the expiry of any signed URL or
  temporary credential belong to the approved deployment.
- **The installed integration is verified by lane G**, not by this lane.
- **The seven-day cost measurement is the user's**, not this lane's.

## 9. Bounded follow-up after the root review

Root reviewed all 14 pull request files and these evidence updates through head
`a1fac535f31a83740176f99909650d419b89ef4c`, and admitted two scoped changes.

### The independent entitlement gate

The acceptance fixture used one set for both the workspace read authorization and the entitlement
policy, so its "unentitled workspace" case failed the membership check and the entitlement policy
was never consulted. The two gates are now separate in the fixture: `workspace-one` is readable and
entitled, `workspace-two` is readable but not entitled, `workspace-three` is neither.

The added cases:

- `apps/web/test/sim-launch-service.test.ts` — a readable workspace the policy does not entitle
  reaches the policy, is refused with `denied/not_entitled`, and no code is stored.
- `apps/web/test/sim-offload-browser/composition-acceptance.test.ts` — the same case in a real
  browser. The policy is consulted about that workspace and surface, the launch code count, the
  session count and the private read count are all unchanged, no frame is created, and Chat and Dev
  stay reachable. The unreadable workspace is refused by the membership check and the policy is
  not asked about it at all, which is what makes the two gates independent.

### Narrowed private-location claims

Identifier and key validation do not prove a storage access control list, and they do not prove
that the storage provider exposes no public alias for the same objects. The source, the tests, the
guide, the plan and this evidence now say exactly that:

- what is proven: a plain location name, a request path that cannot select a key outside the
  location, and an object returned instead of an address, so this service offers no second route
  to a private object;
- what is a deployment prerequisite: the access control list that makes the location private, the
  absence of a public alias for the same objects, and the expiry of any signed URL or temporary
  credential the storage adapter uses.

The approved service composition lists the storage configuration as its own root decision. The two
tests that asserted the stronger claim were renamed and narrowed to the request-side gate.

### The PostgreSQL receipt

The durable database receipt is unchanged and re-verified: 17 tests, 0 failures, 55 assertions
against a real PostgreSQL (the pinned `postgres:18-alpine` image, server 18.6) with 60 migrations
applied, on a disposable container that was removed again afterwards.

## 10. Publication

- Branch: `codex/20261020-hosted-sim-w6`, pushed to `origin`.
- Commits: `a7c4df34738b188b3d16f4a77c376c1c5caf3db0` (the source and the first evidence), then the
  no-Neon proof and the durable integration receipt on the same branch. The bounded follow-up in
  section 9 is one further commit on the same branch.
- Pull request: draft [#1517](https://github.com/adea-ai/adea/pull/1517) against `main`, auto-merge
  off (`autoMergeRequest` is null). Root reviews the exact head; readiness and merge are root's.
- The follow-up was not published as a new pull request, was not marked ready, did not enable
  auto-merge, and made no live change.
- No force push, no secret, no credential and no production change is part of it.
