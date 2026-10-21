# No-Neon proof for the caching and tooling lane

Repository `adea-ai/adea`. Branch `fix/vp-local-cache-lock-release-race`, head `dd3e14320` plus this proof, on
`origin/main` `333b948d4`. Railway is the sole target of the migration this repository is on.

This is the no-Neon proof for the scope the caching and tooling lane owns. It records what was checked, what the check
found, what was removed, what was routed to its owner, and what is **not** claimed.

## 1. The admitted scope

The lane owns the Vite+, Bun and cache implementation, the lock and its tests, and the cache lanes of the CI:

| Area                 | Files                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the local cache      | `scripts/vp-local-run.mjs`, `scripts/vp-local-run.test.ts`                                                                                                                                                       |
| the R2 transport     | `scripts/vp-r2-cache.mjs`, `scripts/vp-r2-cache.cbor.mjs`, `scripts/vp-r2-cache-fixtures.mjs`, `scripts/vp-r2-cache-replay.mjs`, `scripts/vp-r2-cache-transfer.mjs`, `scripts/vp-r2-cache-transfer-fixtures.mjs` |
| the task graph       | `scripts/vite-plus-proof.mjs`, `scripts/orch-graph.mjs`, `scripts/orch-toolchain.mjs`                                                                                                                            |
| the cache CI         | `.github/workflows/task-cache-qualification.yml`, `.github/workflows/vite-plus-proof.yml`                                                                                                                        |
| the tooling manifest | `package.json` (the scripts and the tooling dependencies), `bun.lock`, `bunfig.toml`, `.mise.toml`, `.github/code-foundry.yml`                                                                                   |

## 2. The method

The check reads the committed files. It contacts no service, no registry and no database, and it makes no claim about
the parts of the repository the lane does not own.

```console
$ grep -rn -i "neon" scripts/vp-local-run.mjs scripts/vp-local-run.test.ts scripts/vp-r2-cache*.mjs \
    scripts/vite-plus-proof.mjs scripts/orch-graph.mjs scripts/orch-toolchain.mjs \
    .github/workflows/task-cache-qualification.yml .github/workflows/vite-plus-proof.yml | wc -l
0

$ grep -rn -i -E "postgres|hyperdrive|DATABASE_URL" scripts/vp-*.mjs scripts/vite-plus-proof.mjs \
    scripts/orch-*.mjs .github/workflows/task-cache-qualification.yml .github/workflows/vite-plus-proof.yml | wc -l
0

$ grep -n "secrets\." .github/workflows/task-cache-qualification.yml .github/workflows/vite-plus-proof.yml | wc -l
0

$ node -e "const m=require('./package.json'); const n=Object.keys({...m.dependencies,...m.devDependencies}); console.log(n.filter(x=>/neon/i.test(x)))"
[]
```

The same four checks run as a test, so the property is held and not only recorded:

```console
$ bun test scripts/no-neon-cache-scope.test.ts
10 pass
0 fail
497 expect() calls
```

`scripts/no-neon-cache-scope.test.ts` holds six things:

- every file the guard names is still there, so a renamed file cannot slip past it;
- no file in the scope names a Neon service, package, variable or host;
- no file in the scope names a database service at all - the cache lane's transport is a Cloudflare R2 transport, and a
  database name in this scope would be a coupling to a target the repository is leaving;
- the tooling dependencies name no Neon package;
- the cache workflows use no repository secret and no service credential;
- the shared R2 transport stays off (nothing in the manifest or in any workflow names `ADEA_VP_R2_CACHE_ENABLED` or
  `VP_REMOTE_CACHE`) and its only fallback is the caller's own local cache, never another service.

The guard was mutation-checked: a `NEON_AUTH_BASE_URL` fallback comment added to `scripts/vp-r2-cache.mjs` fails the
guard (`9 pass / 1 fail`), and the file was restored.

## 3. What the check found in the admitted scope

**Nothing.** The thirteen files the lane owns name no Neon service, package, environment variable or host; no database
service at all; and no repository secret. The tooling dependencies name no Neon package.

The R2 transport is the only outbound capability in the scope, and it is off: it is enabled only by
`ADEA_VP_R2_CACHE_ENABLED=1`, and nothing in `package.json` or in any workflow sets it. Its failure behaviour is a
refusal with `fallback: true`, and the caller keeps the cache it already has. **There is no Neon fallback, no
compatibility path and no rollback in the admitted scope.** The only recovery the scope has is a forward fix: a lock
that was released is read as absent and the run waits again, a directory another run created is judged by what it is, a
refused lock falls back to the plain `vp run`, and a failed run is re-run. The recovery of the platform itself is
Railway backup/restore or a forward fix.

## 4. The one trace in this lane's tooling surface, and where it went

`package.json`'s `test:coverage` list names `packages/auth/tests/integration/neon-driver.test.ts`. The name is a Neon
trace in this lane's own tooling surface, but the file belongs to the auth driver's owner and the list is a gate: the
auth driver's test is in the coverage lane, and taking it out would weaken a gate that another lane owns. It is
therefore **not** removed here. It is routed:

| Finding                                                                                    | Owner                                         | What is needed                                                                                               |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `package.json` `test:coverage` names `packages/auth/tests/integration/neon-driver.test.ts` | the auth driver's owner (the cache/auth lane) | the test is renamed or removed with the Neon Auth driver it covers, and the coverage list is updated with it |
| the same list's `packages/db/tests/unit` and the `packages/db` package                     | the database tooling's owner                  | the database package's own Neon removal                                                                      |

The routing is recorded in the lane's handoff record, and it is a removal of the _coupling_, not of the evidence: the
historical receipts that quote a Neon run stay exactly as they are.

## 5. What was found outside the admitted scope, and where it went

The repository still names Neon in 44 files under `apps`, 46 under `packages`, 16 under `scripts`, 2 workflows and 33
documents. None of that is this lane's to remove: the lane owns the cache and the lock, and the packet states that E
exclusively owns the cache and lock code while the other lanes own the rest. It is recorded here so the owners have the
inventory, and it is the whole of the "active Neon traces" picture for the repository:

| Area            | Where                                                                                                                                                                                | Owner                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| the auth driver | `packages/auth` (`@neondatabase/auth`, `createNeonServerAdapter`, `handleNeonAuthRequest`), `apps/web/src/start/routes/api/auth/**`, `apps/web/src/server/workspace-entry-access.ts` | the cache/auth lane (B)                |
| the web app     | `apps/web/cloudflare.config.ts` (the `control-plane-neon` Secrets Store, `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL`, the Neon Auth secrets), `apps/web/start/**`                        | the cache/auth lane (B)                |
| the database    | `scripts/database-config.mjs`, `scripts/database-health.mjs`, `scripts/test-integration.mjs`, `scripts/disposable-postgres-ci.ts`, `packages/db`                                     | the database tooling owner (F, with H) |
| the CI          | `.github/workflows/neon_workflow.yml` and `scripts/neon-branch-resolution.test.ts`, `scripts/neon-workflow-*.test.ts`                                                                | the CI/release lane (F)                |
| the records     | 33 documents under `docs/`, including `docs/database-operations.md`, `docs/control-plane-credentials.md` and the `docs/evidence/**` receipts                                         | kept as the historical record          |

## 6. The historical records are kept, and they are inert

The 33 documents that mention Neon stay committed: they are the accountability record of what was run, when, and with
what result. What does not stay is any _active dependency_ on them. The guard proves it for the admitted scope: no
file the lane owns reads, imports or links any record that mentions Neon, so a record cannot be a live input to the
cache or the lock.

Two of those records are this lane's own: this proof, and
[the lane E cache and tooling receipt](vp-local-cache-lane-e-2026-10-20.md). They mention Neon only to say that the
scope has none, and to route what is not the lane's.

## 7. What is not claimed

- This is a proof for the admitted scope only. It is **not** a repository-wide no-Neon claim, and it does not become
  one by the existence of this file: the repository still names Neon in the areas listed in section 5.
- No Neon integration was removed in this lane, because the admitted scope had none. The one trace in the lane's own
  tooling surface is routed, not removed, for the reason in section 4.
- No live action was taken: no Neon branch, secret, environment variable, workflow run or deployment was touched, and
  no credential was created or read.
- The seven-day cost interval is not a gate of this proof, and no cost measurement is claimed.

## 8. The live actions that need root's approval

These are the operations this proof cannot perform and that the Railway-only target needs. They are reported here
rather than performed:

1. **The Neon CI workflow.** `.github/workflows/neon_workflow.yml` still runs against Neon on push and by dispatch.
   Removing it is the CI/release lane's file, and disabling it in the repository is a live change: root approves.
2. **The Neon branch and its secrets.** The `control-plane-neon` Secrets Store, `AGENT_HQ_NEON_PRODUCTION_DATABASE_URL`,
   `AGENT_HQ_NEON_PRODUCTION_AUTH_BASE_URL` and the Neon Auth secrets are live Cloudflare configuration. Deleting or
   rotating them is a live security action: root approves, and it needs its own recovery plan (Railway backup/restore
   or a forward fix), because a Neon fallback is not permitted.
3. **The Neon branch in Neon itself.** A branch, a database or an endpoint can only be removed by an account that
   holds it. No such call was made from this lane.

Each of the three is a live action on a service this repository is leaving, and none of them is a source change. The
source side of the same work is in the lanes listed in section 5.
