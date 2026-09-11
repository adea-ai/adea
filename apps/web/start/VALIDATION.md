# Validation record

Measured on the migration branch after removing Next.js/OpenNext. Commands are
reproducible from a clean checkout with Node 24.18.0 and Bun 1.4.0.

## Completed checks

| Check                               | Command                                     | Result                                        |
| ----------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Formatting                          | `bun run format:check`                      | Passed (508 files)                            |
| Lint                                | `bun run lint`                              | Passed, 0 errors (2 pre-existing warnings)    |
| Repository typecheck                | `bun run typecheck`                         | Passed (27 packages)                          |
| Unit + coverage                     | `bun run test:unit`                         | Passed (92 tests, 24 tasks)                   |
| Integration (disposable PostgreSQL) | `bun run test:integration`                  | Passed (38 tests)                             |
| Build                               | `bun run build`                             | Passed (14 tasks)                             |
| Cloudflare build                    | `bun run build:cloudflare`                  | Passed; idempotent `wrangler.jsonc` rewrite   |
| Worker config                       | `wrangler deploy --dry-run`                 | Valid: Worker, 55 assets, Hyperdrive binding  |
| Host unit suite                     | `bun run --cwd apps/web start:verify`       | Passed: tests, build, typecheck, client guard |
| Client boundary                     | `bun run --cwd apps/web start:check-bundle` | 40 client files, 0 forbidden modules          |
| Local Worker + browser suite        | `bun run --cwd apps/web start:test:local`   | Passed: 16 browser checks + policy gates      |

The local Worker suite runs the production Worker against a disposable Docker
Compose PostgreSQL database on loopback HTTPS. It verifies real guest sessions,
durable writes, tenant isolation, the restricted-entry redirect, the
restricted-guest API status, and that the entry gate endpoint reports the
policy decision. No Next backend is involved.

## Performance against the retained Next host

Both hosts were production-built from the same machine and served over
loopback HTTPS against one shared disposable database. Five fresh browser
contexts per host, real guest sessions, alternating order; the comparator
fails on browser exceptions or failed workspace API responses.

| Metric                               | Retained Next | TanStack Start | Change |
| ------------------------------------ | ------------: | -------------: | -----: |
| Browser-observed workspace DOM ready |      459.5 ms |       150.8 ms |   −67% |
| Automation-observed view round trip  |      822.5 ms |       141.5 ms |   −83% |
| Loaded JavaScript encoded bytes      |       310,396 |        263,629 | −15.1% |
| Resource transfer excluding HTML     |     345,655 B |      300,182 B | −13.2% |
| Bootstrap requests                   |             1 |              1 |      — |

Reconstruct with:

```sh
# after building the baseline checkout's OpenNext Worker and this branch
ADEA_BASELINE_ROOT=/path/to/baseline bun run --cwd apps/web start:compare:baseline
```

Interpretation limits:

- Unthrottled desktop lab measurement; not field INP, production LCP, or a
  hosted-provider latency benchmark.
- Readiness is a browser `MutationObserver` timestamp for visible shell
  controls, not completion of every remote query; the view round trip includes
  automation overhead.
- Local Hyperdrive emulation, not a hosted Cloudflare region.

Structural reasons the candidate is faster: the root document is rendered by
the same Worker that serves the API (no service-binding hop or gate round
trip), hashed assets are served by the Cloudflare asset layer without invoking
the Worker, and there is no OpenNext request-routing layer or Next client
runtime in the bundle.

## Hosted acceptance (isolated Worker + isolated Neon branch)

Run against a production-built Worker deployed under the distinct name
`adea-web-pr324-acceptance` with secrets scoped to the PR's Neon branch
(`preview/pr-324-refactor/tanstack-start-web`) and that branch's Neon Auth
instance. Neither the production `adea-web` Worker, the production branch, its
secrets, nor its DNS were modified. Evidence is written to the ignored
`start/.checks/hosted/`.

| Area                                                                                 | Result       |
| ------------------------------------------------------------------------------------ | ------------ |
| Browser suite (desktop + mobile, real hosted auth and Postgres)                      | 16/16 passed |
| Guest bootstrap, cookie attributes, rotation flag                                    | Passed       |
| Sign-up, session lookup, sign-in, wrong-password, sign-out                           | Passed       |
| Guest → account workspace claim (same workspace, credential cleared)                 | Passed       |
| Account allowlist: anonymous redirect, listed admitted, unlisted denied early-access | Passed       |
| Desktop authorize/completion, PKCE + fragment handoff, no-store/no-referrer          | Passed       |
| Desktop exchange/refresh/logout/revoke fail closed; untrusted preflight rejected     | Passed       |
| Hostile-Origin state change rejected (403)                                           | Passed       |
| Marketplace, telemetry, scene editor fail closed without hosted credentials          | Passed       |

Commands (any isolated Worker + branch; never production):

```sh
ADEA_ACCEPTANCE_URL=https://<isolated-worker>.workers.dev \
  bun run --cwd apps/web start:accept:hosted

# Allowlist phases: create accounts, enable ADEA_ALLOWED_EMAILS on the isolated
# Worker, then verify.
ADEA_ACCEPTANCE_URL=https://<isolated-worker>.workers.dev \
  bun run --cwd apps/web start:accept:allowlist create
ADEA_ACCEPTANCE_URL=https://<isolated-worker>.workers.dev \
  bun run --cwd apps/web start:accept:allowlist verify

ADEA_ACCEPTANCE_URL=https://<isolated-worker>.workers.dev \
  bun run --cwd apps/web start:accept:gates
```

### Bug found and fixed by hosted acceptance

With `ADEA_ALLOWED_EMAILS` configured, a **signed-in** visitor was redirected
to `/auth/sign-in` instead of being admitted. The Worker entry runs before
TanStack Start establishes its request storage, so the gate's Neon Auth context
resolved no session cookie and every account failed closed. The gate now reads
the session through a request-bound context (`src/server/gate-request-context.ts`)
and propagates any refreshed session cookie onto its own response. This also
required the hosted auth provider's trusted-origin list to include the
deployed origin; production `adea.dev` currently returns `INVALID_ORIGIN` from
the provider for the same reason, which is a pre-existing hosted configuration
gap rather than a migration regression.

## Not exercised here

- Hosted OAuth/social provider callbacks (the branch has email/password only,
  and no social provider credentials were available).
- Live marketplace/event delivery against a real Control Plane.
- Production Cloudflare deployment, DNS, and custom-domain behavior.
- The private Agent Sim engine integration beyond the shared workspace shell.

These remain the pre-promotion acceptance items in
[README.md](README.md#rollback). The migration itself changes no database
schema, so rollback is a code revert plus a Worker redeploy.
