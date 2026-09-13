# Adea Desktop

The desktop target is an Electrobun (Bun + CEF) application that ships its React
client as packaged local assets. The shell's Bun main process serves the built
client on loopback and never loads the Adea web deployment as the privileged
top-level view. Shared browser-safe packages remain reusable, while Next.js
handlers, `/auth/server`, `/db`, provider SDKs, and other server-only modules
stay out of the bundle.

Run `bun run shell:dev` from this directory to build the client and launch the
shell against it. `bun run client:build` produces the assets the shell serves
from disk. The public `VITE_ADEA_CLOUD_ORIGIN` build setting may select an
approved Adea deployment; `scripts/cloud-config.mjs` validates that value for
every consumer. Release builds default to `https://adea.dev`.

First launch opens directly into the bundled Home or Work workspace scene. The cloud workspace service
creates a temporary canonical user, owner membership, and default Home and Work workspaces without requiring
authentication; the opaque guest credential is kept in the operating-system credential store. The
workspace remains usable for the current process if that store is unavailable, and the top bar
offers optional sign-in at any time to claim and persist the same workspaces.

Desktop sign-in starts in the system browser and returns through the registered
`adea://auth/callback` scheme. The local client creates state, nonce, and a
PKCE verifier; the shell accepts only the fixed desktop authorization endpoint;
and the callback carries only a short-lived one-time code. The pending PKCE
attempt is kept in the shell's encrypted state directory until it is consumed.
The client build injects the exact origin selected by `scripts/cloud-config.mjs`;
the browser-safe broker pins requests to that same origin.
The provider-neutral code exchange and session lifecycle live in
`/auth/desktop`, while one-time consumption and credential rotation
belong to the server-side `/auth/server` broker. Codes and user-session
credentials are hashed before PostgreSQL storage and never appear in callback
URLs.

The MVP is online-first. On restart, the desktop session manager loads a user
session from the operating-system credential vault and refreshes it through the broker. The
rotating device session remains valid for 30 days after its most recent successful refresh, without
depending on the browser session that granted it. A network failure produces an explicit offline
state without treating stale credentials as authorization for cloud work. Expired, revoked, or
malformed sessions are cleared. Sign-out and user-session revocation do not delete or revoke the
separate RuntimeNode device credential.

## Virtual view and Agent Sim

The virtual view mounts the Agent Sim engine only on entitled deployments:
official desktop builds pack the engine at build time
(`release-assets.yml` checks out the private `agent-sim` repo when
`AGENT_SIM_REF`/`AGENT_SIM_DEPLOY_TOKEN` are configured), and local builds can
do the same by pointing `ADEA_AGENT_SIM_DIST` at a local engine pack before
`shell:build`. Builds without a pack — including any fork's — render the
offline fallback and never fetch engine code.

There is no auto-update lane in the Electrobun shell yet: the client's update
surface reports up to date, and release-lane work (including `adea://`
URL-scheme registration for the auth callback) is tracked in #370.
