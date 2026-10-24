# M13 #536 chat readiness acceptance — 2026-10-22

Scope: [adea-ai/adea#536](https://github.com/adea-ai/adea/issues/536) (M22.02, slice S6 of the
M13 chat plan) — the chat-side readiness package for the M13 certification gates
[#42](https://github.com/adea-ai/adea/issues/42) and [#130](https://github.com/adea-ai/adea/issues/130).

This record is the result of running the acceptance work this lane is authorized to run locally and
natively, on the branch `test/installed-desktop-ui-acceptance-20261020` at
`29343321e0d3b96522ff19d0db0e5d9dada56c81` (the checkout at
`/private/tmp/opencode-three-fleet-20261018/workers/worker-3/adea-g-installed-ui-acceptance`).

**This is not a closure.** The chat owner journey on the packaged build, the Dev↔Chat
repeated-switch proof on the packaged build, the WCAG 2.2 AA browser audit, the 24-hour soak and
the 2026-10-21 stable-artifact acceptance are **not** satisfied here, and the reasons are in §5.
Nothing below is evidence for any of them, and issue #536 stays open.

## 1. What was run, and what it produced

| Lane                                 | Command                                                                                                                                 | Result                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat surface unit coverage           | `bun test packages/dev-view/tests/chat-*.test.ts`                                                                                       | **446 pass, 0 fail, 1,598 assertions** across 24 files (2.58 s)                                                                                                                                                                                                                                |
| Security lane                        | `bun run test:security:dev-runtime`                                                                                                     | **passed** — 37 + 15 + 7 = 59 tests, 0 fail. Artifact: `artifacts/dev-runtime/security-summary.json`                                                                                                                                                                                           |
| Performance lane                     | `bun run test:performance:dev-runtime`                                                                                                  | **passed**. Artifact: `artifacts/dev-runtime/performance-summary.json`                                                                                                                                                                                                                         |
| Soak lane (short local verification) | `bun run test:soak:dev-runtime`                                                                                                         | **passed** — rounds=1, bytes=1,360,163, frames=34, probes=2, storms=0, churn=0, elapsed 20,975 ms; the terminal phase passed with 6 verified assertions and 0 failures. Artifacts: `artifacts/dev-runtime/soak-summary.json`, `soak-terminal-phase-summary.json`, `terminal-soak-summary.json` |
| Native installed-app acceptance      | `bun scripts/installed-app-acceptance.ts --app-bundle apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app --profile-parent <run dir>` | **refused, as designed** — `{"passed":1,"failed":0,"pending":24,"total":25,"ok":false}`. The application was **not installed, not registered and not launched**                                                                                                                                |
| Chat browser acceptance              | `bun run test:e2e:chat`                                                                                                                 | **failed to start** — the web server never came up (§5.2)                                                                                                                                                                                                                                      |
| Packaged dev-runtime lane            | `bun run test:packaged`                                                                                                                 | **failed** — three proofs passed, one probe exited 1 by design, the browser matrix timed out (§5.3)                                                                                                                                                                                            |

Prerequisites built for the native run, in this checkout: the workspace packages
(`types`, `ui`, `remote-content`, `auth`, `api-client`, `state`, `db`), the desktop web client
(`bun run --cwd apps/web desktop:build`, 187 rendered shared UI modules against 287 Tailwind
sources, 317 files) and the Electrobun bundle
(`bun run --cwd apps/desktop shell:build` → `apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app`).

The performance lane's measurements, as reported: 1,000 bounded captures in 18.5 ms (budget 5 s);
listing page p95 0.5 ms across 200 pages (cold 100k merge 69 ms, full flatten 4 ms over 100,001
rows); a 10k-line document in 5.7 ms; a 10k-hunk split in 2.8 ms; RSS 127 MB; and 1,000 processes
over 100 sessions in 16 bounded `ps` calls with row p95 0.05 ms.

## 2. The native installed-app acceptance, in its own words

The run produced the preflight artifact and refused to go further:

> installed-app acceptance: no supported native profile isolation contract is in force; the native
> renderer resolves its profile root from the real user home and the devkit exposes no per-run root,
> so launching writes into the operator's own Application Support directory; the application is NOT
> installed, NOT registered and NOT launched, and every row that needs it stays pending

One row passed and **24 of 25 rows are pending** — every row that needs the installed application.
The isolation gate was not bypassed, no profile was written under the real user's Application
Support, and no evidence was invented for the pending rows.

## 3. What this lane is authorized to run, and what it is not

The issue's scope asks for the chat owner journey **on the packaged build**, the Dev↔Chat
repeated-switch proof **on the packaged build**, the WCAG 2.2 AA audit of the chat surface, the
performance budgets extended with chat numbers, and a 24-hour multi-conversation soak, with the
evidence landing in the named lanes (`test:packaged`, `test:security:dev-runtime`,
`test:performance:dev-runtime`, `test:soak:dev-runtime`, and the visual lane).

Of those, this lane ran the three dev-runtime lanes and the native preflight, and wrote their
artifacts under `artifacts/dev-runtime/`. The packaged build, the browser lanes and the 24-hour
soak are outside what this lane can complete here (§5).

## 4. The chat-side inputs #42 and #130 consume

The chat-side input table for both certification gates — which canonical-conversation scenarios
Chat satisfies through the `RuntimeSession` projection and which remain Slack-style-surface
scenarios, with the artifact each input's evidence lives in — is recorded in the qualification
record `docs/evidence/m13-536-chat-cross-product-readiness-2026-10-21.md` (§4) on the
`codex/m536-chat-readiness-qualification-20261021` branch, with the composition map in §3 and the
open gates in §5 of that record. This record adds the executed lanes and the blockers; it does not
restate the input table.

## 5. The remaining acceptance blockers

### 5.1 The native install and launch — the isolation contract

The installed-app acceptance needs a supported, validated per-run native profile root before it
may install, register or launch. The native renderer resolves its profile root from the real user
home and the devkit exposes no per-run root, so launching would write into the operator's own
Application Support directory. That gate is in force and is unchanged: 24 of 25 rows stay pending.
The chat owner journey and the Dev↔Chat repeated-switch proof on the packaged build are blocked
here.

### 5.2 The browser lanes — the dev server does not start

`bun run --cwd apps/web dev` (the web server every browser lane starts) fails while the
Cloudflare Vite plugin fetches the worker's export types:

```
TypeError: ECONNREFUSED: Unable to connect. Is the computer able to access the url?
  at async fetchWorkerExportTypes (@cloudflare/vite-plugin/dist/index.mjs)
  path: 'http://localhost/__vite_plugin_cloudflare_get_export_types__'
```

The Vite server itself starts ("[vite] (ssr) [optimizer] scanning dependencies...") and the failure
is the plugin's worker runtime never accepting the request. It was reproduced in this checkout with
the workspace packages built, with the local e2e database on `127.0.0.1:55432`, under both the
ambient Bun 1.4.2 and the repository's pinned Bun 1.4.3, and it is the same failure the
`docs/evidence/installed-desktop-ui-acceptance-2026-10-20.md` record (§2) already documents for
this lane.

Blocked by it, in this checkout: `bun run test:e2e:chat` (the chat browser acceptance, which
carries the repeated Dev↔Chat switch proof — "repeated Dev↔Chat switches preserve the session state
in the real window" — and the streaming, draft, approval, reconnect and reading-position coverage),
`bun run test:e2e:visual:chat` (the chat visual lane), the WCAG 2.2 AA browser audit of the chat
surface, and the packaged lane's browser matrix.

### 5.3 The packaged dev-runtime lane

`bun run test:packaged` ran three proofs green — `supervision-smoke`, `terminal-replay`,
`worktree-containment` — and then stopped:

- `transport-defect-probe` exited 1 with the lane's own note that _the transport defect no longer
  reproduces_ and the probe stays as a fixture; the durable bridge replay is proven by the
  `terminal-replay` lane;
- `browser-matrix` timed out (exit 124) — the same dev-server blocker as §5.2.

The lane's summary artifact is `artifacts/dev-runtime/packaged-summary.json` with
`status: failed`.

### 5.4 The 24-hour soak

`bun run test:soak:dev-runtime` is the short local verification: 20 rounds by default, 1 round in
this run, 20.975 s. The acceptance asks for a 24-hour multi-conversation soak with bounded
memory, disk and descriptors, which is a separate, deliberately long run and was not performed here.
The lane supports it by count and by wall clock (`ADEA_DEV_RUNTIME_SOAK_DURATION_MS`,
`ADEA_DEV_RUNTIME_TERMINAL_SOAK_DURATION_MS`).

### 5.5 The 2026-10-21 current stable artifact acceptance

The seven packaged/native bullets of that block — the exact automatically published stable tag,
artifact and source head with the shipped UI/Themes/Plugins versions; a fresh isolated
profile/install of that artifact; the Chat/Dev journeys on it; first-install navigation exposing only
Chat/Dev; Virtual/Kanban/Source Tree requiring explicit opt-in; the disable/re-enable/reload
behaviour and the old-preference migration; and no Agent Sim asset or network fetch before opt-in —
are the release lane's. This issue authorizes no manual release or deployment and no destruction of
the user's existing install or data, and the stable artifact's identity is not derivable from this
repository's tags (the tags carrying a stable-looking version are not ancestors of `main`). The
eighth bullet, the #1522 body/head evidence reconciliation, is source-side and was completed
separately.

### 5.6 The certification runs themselves

#42 and #130 remain the gates. They additionally require the Control Plane release candidate, which
is external to this repository, and this slice does not close them.

## 6. Non-claims

- **No acceptance criterion is claimed satisfied.** The chat owner journey on the packaged build, the
  Dev↔Chat repeated-switch proof on the packaged build, the WCAG 2.2 AA audit, the 24-hour soak and
  the stable-artifact acceptance are all open, and issue #536 stays open.
- **No evidence was invented and no blocked gate was bypassed.** The native run refused; the browser
  lanes are reported as failing to start, with the error.
- No credential was used or required, no credential helper was invoked with a stored secret, no
  security setting changed, nothing was deployed or released, no migration ran against a
  non-local target, no packaged artifact was installed, no desktop application was launched, and no
  issue was closed.
- The four certification gates — native, packaged release, provider, production — stay open, and the
  Dev↔Chat / chat-journey holds are unchanged.
