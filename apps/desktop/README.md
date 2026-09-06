# Adea Desktop

The desktop target is a Tauri 2 application that ships its React client as
packaged local assets. It never loads the Adea web deployment as the
privileged top-level WebView. Shared browser-safe packages remain reusable,
while Next.js handlers, `/auth/server`, `/db`, provider SDKs,
and other server-only modules stay out of the bundle.

Run `bun run shell:dev` from this directory to start the local Vite client and
open it in Tauri. `bun run client:build` produces the assets embedded by Tauri.
The public `VITE_ADEA_CLOUD_ORIGIN` build setting may select an approved
Adea deployment; native code reads that same compile-time value when it
allowlists the authorization origin. Release builds default to
`https://adea.dev`.

First launch opens directly into the bundled Home or Work workspace scene. The cloud workspace service
creates a temporary canonical user, owner membership, and default Home and Work workspaces without requiring
authentication; the opaque guest credential is kept in the operating-system credential store. The
workspace remains usable for the current process if that store is unavailable, and the top bar
offers optional sign-in at any time to claim and persist the same workspaces.

Desktop sign-in starts in the system browser and returns through the registered
`adea://auth/callback` scheme. The local client creates state, nonce, and a
PKCE verifier; the native launcher accepts only the fixed desktop authorization
endpoint; and the callback carries only a short-lived one-time code. The
pending PKCE attempt is kept in the operating-system credential vault until it
is consumed, so a callback that launches a new desktop process can still finish
without weakening state or nonce verification. The packaged CSP permits HTTPS
API connections only to the exact origin selected by the desktop build wrapper;
the browser-safe broker and native launcher pin requests to that same origin.
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

Signed desktop updates are published separately from the private source
repository at `https://updates.adea.dev/desktop-updates/latest.json`. The
release-assets workflow rewrites Tauri's generated private GitHub asset URLs
to that public channel, then uploads only the signed updater packages and
manifest to R2.
