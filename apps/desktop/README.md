# Adea Desktop

The desktop target is an **Electrobun (Bun + CEF) shell around the single web
UI**. There is no desktop-only client: the shell serves the web app's own
TanStack Start SPA build on loopback and injects the `window.__adeaDesktop`
bridge before the app boots.

```
apps/desktop/shell          Electrobun shell (Bun main process, CEF view)
apps/desktop/scripts        build orchestration (client.mjs, shell.mjs, cloud-config.mjs)
apps/web                    the one UI source (desktop-only surfaces are flag-guarded)
apps/web/dist-desktop       the SPA output the shell serves (built, not committed)
```

## Build and run

```sh
# builds apps/web's desktop SPA output (and the workspace packages it needs)
bun run shell:client:build

# builds the client, then bundles the shell with Electrobun
bun run shell:build

# development shell (Electrobun dev loop over the same client build)
bun run shell:dev
```

`shell:client:build` runs `apps/web`'s `desktop:build` with
`ADEA_DESKTOP_CLOUD_ORIGIN` set from the canonical
`scripts/cloud-config.mjs` value (release default `https://adea.dev`). The
shell itself never restates the cloud origin; `scripts/check-desktop-origins.mjs`
enforces that. The shell serves `apps/web/dist-desktop/client` by default
(`ADEA_CLIENT_ROOT` overrides it) and opens a window at
`http://127.0.0.1:4789`.

## Why the shell serves the web app's build

The owner contract is that the desktop is a pure shell of the single web UI, so
the shell loads exactly one client source. Two variants were considered:

1. **Shell loads the deployed web app and injects the bridge into the remote
   page.** Rejected: the page origin would be `https://adea.dev`, so the control
   plane would have to trust the public web origin as a desktop origin (any
   script on the deployed site could then send the desktop-client header), and
   the shell would depend on the latest deployment instead of its bundled UI.
2. **Shell serves a client-side build from the web app's build pipeline
   (chosen).** `apps/web/vite.desktop.config.ts` builds the same source with
   TanStack Start SPA/prerender mode into `apps/web/dist-desktop/client`, so the
   page origin stays the loopback origin the control plane already trusts
   (`http://127.0.0.1:4789`, see `apps/web/src/server/desktop-workspace.ts`),
   the shell keeps working from its own bundle, and the deployed web app and the
   desktop client cannot drift into different component trees.

The bridge is injected server-side into the served HTML (`/__adea/bridge.js`),
and commands are dispatched to the shell's registry (`/__adea/invoke` →
`shell/src/commands.ts`). The client half lives in
`apps/web/src/lib/desktop-bridge.ts`; desktop runtime wiring (session vault,
PKCE, guest credential, platform providers) lives in
`apps/web/src/lib/desktop-*.ts` and the flag-guarded
`apps/web/src/components/desktop-workspace-entry.tsx`.

First launch opens directly into the bundled Home or Work workspace scene. The
cloud workspace service creates a temporary canonical user, owner membership,
and default Home and Work workspaces without requiring authentication; the
opaque guest credential is kept through the shell's encrypted state directory.
The workspace remains usable for the current process if that store is
unavailable, and the global rail offers optional sign-in at any time to claim
and persist the same workspaces.

Desktop sign-in starts in the system browser and returns through the registered
`adea://auth/callback` scheme. The client creates state, nonce, and a PKCE
verifier through `@adea-ai/auth/desktop`; the shell accepts only the fixed
desktop authorization endpoint and keeps the pending PKCE attempt in its
encrypted state directory until it is consumed. Codes and user-session
credentials are hashed before PostgreSQL storage and never appear in callback
URLs. URL-scheme registration for the callback is still release-lane work
(tracked in #370).

The MVP is online-first. On restart, the desktop session manager loads a user
session from the shell state and refreshes it through the broker. The rotating
device session remains valid for 30 days after its most recent successful
refresh, without depending on the browser session that granted it. A network
failure produces an explicit offline state without treating stale credentials
as authorization for cloud work. Expired, revoked, or malformed sessions are
cleared. Sign-out and user-session revocation do not delete or revoke the
separate RuntimeNode device credential.

## Virtual view and Agent Sim

The virtual view mounts the Agent Sim engine only on entitled deployments:
official desktop builds pack the engine at build time
(`release-assets.yml` checks out the private `agent-sim` repo when
`AGENT_SIM_REF`/`AGENT_SIM_DEPLOY_TOKEN` are configured), and local builds can
do the same by pointing `ADEA_AGENT_SIM_DIST` at a local engine pack before
`shell:build`. Builds without a pack — including any fork's — render the
offline fallback and never fetch engine code.

There is no auto-update lane in the shell yet: the update surface reports up to
date, and release-lane work (including `adea://` URL-scheme registration for the
auth callback) is tracked in #370.
