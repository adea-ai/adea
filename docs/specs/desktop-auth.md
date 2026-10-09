# Spec: desktop authentication

The native shell's half of the desktop sign-in handoff: what it accepts, what it
stores, and what it refuses. The cloud half (endpoints, Neon Auth, digest
storage) lives in [Authentication boundary](../authentication.md); this page is
the contract to read before touching the desktop flows in
`packages/auth/src/desktop.ts`, the shell command family in
`apps/desktop/shell/src/commands.ts`, or the client runtime in
`apps/web/src/lib/desktop-runtime.ts`.

[ADR 0011](../decisions/0011-unified-workspace-projects.md) adds the
membership-checked device workspace scope for the Dev runtime (see
[Device workspace scope](#device-workspace-scope)). It does not change the
sign-in handoff below.

> **Implementation note (2026-09-13):** the desktop shell is Electrobun (Bun +
> CEF); see [ADR 0006](../decisions/0006-browser-lanes-and-desktop-shell.md).
> Rust module paths below refer to the previous shell. The shell implements the
> auth command family in `apps/desktop/shell/src/commands.ts`
> (`desktop_auth_start` opens the URL in the system browser;
> `desktop_auth_take_callback` is a single read-and-clear). The single web UI
> runs in the shell through `apps/web/src/lib/desktop-runtime.ts` and
> `apps/web/src/components/desktop-workspace-entry.tsx`; the shell serves the
> web app's SPA build on loopback
> (`apps/desktop/scripts/client.mjs` → `apps/web/dist-desktop/client`), and
> the client's in-app cloud calls ride the shell's same-origin `/api` proxy
> (`apps/desktop/shell/src/cloud-proxy.ts`). Deep-link/URL-scheme registration
> for the `adea://` auth callback is not yet carried by the shell;
> release-pipeline registration is still release-lane work.

## Current storage boundary

The Electrobun command registry uses AES-GCM files in `desktop-state` for the
user session, pending authorization attempt, and temporary workspace credential.
It keeps their shared encryption key in the local `device.key` file. This is
separate from the Dev Runtime vault and does not establish OS credential-store
protection for these three values. The legacy vault requirements below describe
the target contract, not the current shell's storage implementation.

`local_content_rotate_key` currently deletes the shared key file without
re-encrypting the saved values. The next key access creates a new key, and old values
cannot be read through that key. This command is not evidence of safe credential
or content rotation. Callback URL-scheme registration also remains release-lane
work. Cloud broker and client validation tests do not establish either native
storage protection or packaged callback registration.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## Device-local identity (guest mode)

Sign-in is an upgrade, never a gate. The shell mints a durable device-local
identity on first boot — a guest scope triple (account, workspace, runtime
node) of random UUIDs persisted owner-only at `dev-runtime/identity/local.json`
in the shell data directory — and every Dev Runtime command authorizes against
it when no cloud binding exists. The identity is created by the shell, never
asserted by the renderer, so the "renderer never self-asserts a scope" rule
holds with no account in the picture; a command naming any other scope is
refused `channel_unauthorized` exactly as before. The guest scope is never
rotated or deleted: projects, sessions, worktrees, and history keyed to it
survive restarts and every sign-in/sign-out cycle.

Cloud sign-in supersedes the guest scope until sign-out. `desktop_identity_bind`
keeps its full cloud verification (credential liveness, workspace membership,
node pairing); a successful bind notifies the composition, which revokes every
channel minted under the guest scope. Sign-out (`desktop_identity_unbind`)
drops the cloud binding, revokes its channels, and returns to the SAME
device-local scope — the signed-out surface is alive, not stranded.
`ensureNodeEligible` re-proves against the cloud only while a cloud binding is
active; the device-local node is the shell's own machine, where the shell is
the eligibility authority.

`desktop_identity_scope` therefore always answers with the active scope, and
`identityKind()` reports `guest` or `cloud` — surfaces read that to keep
sign-in an optional entry point for features that genuinely require an account
(remote linking, mobile companion), not a first-run wall. Data migration
between the guest scope and a cloud workspace is deliberately out of scope
until a remote feature ships; today a bind starts authoring NEW work under the
cloud scope and existing guest-keyed data stays device-local.

## Device workspace scope

`desktop_identity_select_workspace({ workspaceId, credential })` selects the
Dev scope for one cloud workspace. `credential` is either
`{ kind: 'desktop', session }` (the signed-in desktop session) or
`{ kind: 'temporary', credential }` (the guest's `adea_tmp_…` temporary
workspace credential); anything else, or a non-canonical workspace id, is
refused `invalid_state` before any network call, and an expired desktop
session is refused `unauthenticated`.

- **Verification.** The shell calls the cloud's `GET /api/workspaces` with the
  same desktop lane headers as `desktop_identity_bind` (`Authorization:
Desktop …` plus `X-Adea-Desktop-Session`, or `Authorization: Temporary …`).
  The listing is authoritative: the workspace must appear in it, otherwise the
  call is refused `unauthorized` (403). A cloud refusal of the credential
  (`unauthenticated`, malformed listing) also forgets that credential's cached
  memberships.
- **Membership cache.** Every workspace in a verified listing is cached owner-
  only at `dev-runtime/identity/memberships.json`, keyed by a SHA-256 digest of
  the credential (the credential itself is never written), with an expiry of
  `IDENTITY_LIMITS.membershipCacheTtlMs` (24 hours; at most
  `maxCachedMemberships` = 256 entries). A fresh listing replaces the
  credential's entries, so a removed membership stops admitting selection at
  the next online check.
- **Offline.** Only when the cloud is unreachable (network failure,
  `unavailable`) does the shell consult the cache: an unexpired entry for the
  same credential digest and workspace admits the selection; anything else is
  refused `workspace_unavailable` (503, retryable). Offline switching is
  therefore limited to workspaces this credential already verified.
- **Scope.** On success the active scope becomes `{ accountId: local
accountId, workspaceId: <cloud workspace id>, runtimeNodeId: local
runtimeNodeId }` with `identityKind()` `device`, persisted at
  `dev-runtime/identity/device-scope.json`. While the admitting membership is
  expired or forgotten the selection keeps its scope (so the composed host and
  the gate agree) but every Dev command fails `workspace_unavailable` until a
  fresh selection re-proves membership.
- **Precedence.** A paired `desktop_identity_bind` binding is untouched and
  wins: selecting its own workspace returns the bound scope (`kind: 'cloud'`);
  selecting any other workspace is refused `identity_mismatch` (409). After
  `desktop_identity_unbind` the device selection, not the guest scope, becomes
  active.
- **Channels.** An effective scope change revokes every channel through the
  same path as a rebind, and the host recomposes under the new scope. Because
  the caller's own channel is revoked, the reply to that authenticated call
  carries a fresh single-use launch bootstrap (`rehandshake`) that the
  injected bridge consumes inside its closure to re-handshake; the renderer
  never receives it. Re-selecting the active workspace changes nothing.
- **Partitions.** Each workspace scope has its own register partition. The
  previous device-local guest partition is never read, migrated, or deleted by
  a selection; it stays on disk for the owner.
- **Failures.** Refusals reach the client as `<code>: <message>`; the active
  scope is unchanged. The web client selects before the store switches
  workspaces (`onAuthorizeWorkspace`) and on bootstrap, never blocks the
  workspace switch on a refusal, and keeps Dev unavailable whenever the
  selection failed or the shell scope names another workspace.

## One cloud origin

`apps/desktop/scripts/cloud-config.mjs` owns the origin: `DEFAULT_CLOUD_ORIGIN`
plus `normalizeDesktopCloudOrigin()`. `apps/desktop/scripts/client.mjs`
validates it and passes it into the web app's desktop build, which injects it as
the `__ADEA_DESKTOP_CLOUD_ORIGIN__` build constant that
`apps/web/src/lib/desktop-runtime.ts` reads for the authorize URL the system
browser opens. `scripts/check-desktop-origins.mjs` fails the build on any other
origin literal in the scanned desktop client files.

Inside the app the client never talks to the cloud cross-origin: the API client
and session broker target the shell's own loopback origin, and the shell
forwards `/api/*` to the canonical cloud origin
(`apps/desktop/shell/src/cloud-proxy.ts`, overridable with
`ADEA_CLOUD_ORIGIN` for a local stack). The proxy forwards the request's
credential headers untouched and states the loopback origin the cloud's desktop
lane already trusts, so the webview stays on one origin and the cloud keeps a
single trusted desktop origin.

`validate_authorization_url` accepts a URL only when the scheme, host, and port
equal the cloud origin's, the path is exactly `/api/auth/desktop/authorize`,
there are no credentials and no fragment, and the query carries exactly seven
parameters: `client=desktop`, `code_challenge_method=S256`,
`redirect_uri=adea://auth/callback`, `response_type=code`, and bounded
`code_challenge`, `nonce`, and `state`. Any of `access_token`, `id_token`,
`refresh_token`, `session_token`, or `token` is rejected outright. A URL that
carries a credential never reaches the browser.

## The callback

The target shell contract registers the `adea://` scheme and accepts a callback only when its
`scheme://host/path` is exactly `adea://auth/callback`, with no credentials and
no fragment, carrying exactly `code`, `nonce`, and `state`. A valid callback is
queued **once** (`DesktopAuthState::take`) and the main window is revealed and
focused, so a callback that arrives while the app is running surfaces the window
waiting for it. Callbacks arrive from the deep link channel
(`auth::start_deep_link_channel`, part of the boot steps) and from the
single-instance handoff in `main.rs`.

The client half generates the state, nonce, and S256 PKCE verifier, then
exchanges the one-time code through the same-origin handler. The custom callback
never carries an access, refresh, provider-session, or application-session
credential.

## Vault entries

The target keeps all three in the operating-system credential store under the service
`com.adea.desktop`:

| Keychain user                   | Holds                                             | Validation on read and write                                                                                                                            |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-authorization-attempt` | the pending PKCE attempt                          | base64url `code_challenge`/`code_verifier` 43–128, `nonce`/`state` 16–512, `redirect_uri` exactly `adea://auth/callback`, non-zero expiry, `used` false |
| `desktop-user-session`          | the opaque user session                           | credential 32–512, `session_id` 16–128, `expires_at` 20–64, no whitespace in either identifier                                                          |
| `temporary-workspace-session`   | the guest credential (`adea_tmp_` + 43 base64url) | exact prefix and length, base64url alphabet                                                                                                             |

A malformed entry is treated as absent for reads and never written on save. The
pending attempt is kept in the vault rather than memory so a callback that
launches a _new_ process can still finish, without weakening state or nonce
verification.

## Session lifecycle

- The attempt expires five minutes after it is created.
- A device session rotates on every successful refresh and stays valid for 30
  days after its most recent refresh; the browser session that granted it is not
  required afterwards.
- Network failure produces an explicit offline state. Stale credentials are not
  treated as authorization for cloud work.
- Expired, revoked, or malformed sessions are cleared.
- Sign-out and user-session revocation do **not** delete or revoke the separate
  RuntimeNode device credential.
- The account allowlist (`ADEA_ALLOWED_EMAILS`) gates device sessions as well as
  browser sessions, and it is checked when a session is **resolved**, not only
  when one is issued. The provider email is recorded on the authorization code
  and carried onto the session, so tightening the allowlist stops already-issued
  device sessions immediately instead of leaving them working for their full 30
  days. A session whose email is absent, including one issued before the column existed,
  is **denied** while an allowlist is configured, so an old record is never a
  way past the allowlist. With no allowlist configured the check is a no-op.

## IPC contract

`desktop_auth_*`, `desktop_user_session_*`, and `desktop_temporary_workspace_*`
exist only in the shell's `handlers` registry
(`apps/desktop/shell/src/commands.ts`), which the bundled main window reaches
through `/__adea/invoke`. Since M10 #33 that path is no longer an open
authority: the injected bridge performs `dev.runtime.handshake.v1` with a
single-use launch bootstrap and signs every request with a per-channel HMAC
(`apps/desktop/shell/src/dev-runtime/channel/`); unauthenticated,
cross-origin, rebinding, replayed, and tampered requests fail closed with
typed errors. The Dev Runtime scope family `desktop_identity_bind`,
`desktop_identity_scope`, `desktop_identity_select_workspace`, and
`desktop_identity_unbind` rides the same signed path but is composed in the
shell entry (`src/dev-runtime/channel/identity-commands.ts`, routed from
`src/bun/index.ts`), not the `commands.ts` registry: bind verifies the
presented desktop session against the cloud plus the paired runtime node
before any Dev Runtime scope exists, select verifies workspace membership as
described above, and unbind (sign-out) revokes every channel minted under the
binding. The
launch bootstrap itself is delivered only with document loads that present
trusted browser fetch metadata, so a header-less local process cannot
retrieve it from the served HTML. The bulk-stream relay family
`desktop_file_stream_open`, `desktop_file_stream_frame`, and
`desktop_file_stream_close` (Dev Runtime #399) composes in the shell entry
alongside the identity family. It needs the channel authority and gateway
instead of the `commands.ts` registry, and re-proves the channel binding on every
operation: `open` consumes the attach through the authority's real
`attachStream` (single-use, 60 s, caller-channel-bound, attach proof signed by
the bridge under its channel secret inside its closure), and `frame`/`close`
are refused unless they present the exact channel identity the stream was
attached under. `desktop_auth_start` additionally refuses
to open any URL that is not a credential-free authorize URL on the canonical
cloud origin. The client still owns the full `validate_authorization_url`
check. The registered command set and the commands the client actually
invokes must match exactly: `scripts/desktop-ipc-boundary.test.ts` fails the
build otherwise, and `apps/desktop/tests/shell-commands.test.ts` exercises
the family round-trips over the guarded path, with the channel boundary
itself pinned by `apps/desktop/tests/shell-channel.test.ts` and the identity
binding and gate ordering by
`apps/desktop/tests/dev-runtime-composition.test.ts`.

`desktop_chat_presentation` is a signed, ephemeral presentation hint. Its
optional runtime-session ID is accepted only when it resolves in the current
host's authenticated, non-archived projection. It never grants input or
command authority. A host recomposition preserves this hint only when the
authenticated scope is unchanged and the new host projection still resolves
the same non-archived session; an unbind, scope change, or invalid session
clears it. The shell derives notification intent only from canonical
durable `run.status` transitions and suppresses notifications when the desktop
window is focused with a selected runtime session. Native requests contain only the fixed title
`Adea` and body `A conversation needs your attention.`; an API call returning
is not a delivery receipt. Missing or throwing notification APIs do not alter
the durable run transition.

The shell imports the pure `@adea-ai/dev-view/chat/notifications` contract for
this host-only derivation. This is a runtime contract dependency, not a second
desktop client graph: the client remains the web workspace build. Keep the
notification subpath free of UI, styling, and browser modules; the desktop
boundary test bundles the real shell notification entry to check that graph.

## Pinned by

- `packages/auth/tests/unit`: origin allowlist, callback replay and credential
  rejection, single-use callback, vault validation for all three entries.
- `packages/auth/tests/unit`: the default and injected origins are bare origins.
- `scripts/desktop-origin-boundary.test.ts`: the canonical constant, the derived
  call sites, and no stray origin literal.
- `scripts/desktop-ipc-boundary.test.ts`: the command surface above.
- `apps/desktop/tests/shell-server.test.ts`: the proxy targets the canonical
  origin, presents the trusted shell origin, and drops ambient headers.
- `apps/desktop/tests/device-workspace-scope.test.ts`: device workspace scope
  refusals (non-member, offline-unverified, expired cache, malformed
  credential, paired binding elsewhere), the bridge re-handshake after a
  switch, per-workspace partitions, and the untouched guest partition.
- `apps/web/test/desktop-dev-scope.test.ts`: the client selects before it
  reads the shell scope and keeps Dev unavailable on refusal or mismatch.
- `apps/desktop/tests/shell-channel.test.ts`: the invoke path authenticates
  the shell channel (bootstrap handshake, per-request HMAC, replay and
  origin refusals) before a handler runs.

### Workspace deletion lifecycle commands

The trusted signed-window identity command family includes
`desktop_identity_workspace_cleanup_prepare`, `_commit`, `_cancel`, and `_pending`
(with the complete shared prefix). Prepare accepts a workspace ID and the existing
desktop/temporary membership credential; the shell requires a fresh owner-only
`GET /api/workspaces/<id>/delete` proof, exact current scope and idle resources. The persistent personal root never supplies deletion proof, even after renaming or changing its mark.
Its durable operation UUID binds the scope; Commit/Cancel never accept a renderer
scope assertion. Commit requires fresh cloud `deleted` owner proof and can
resume the shell-owned saved scope after restart; the active host must be idle
before temporary cleanup composition. Cancel requires fresh `active` proof and a
prepared operation. Cloud uncertainty stays paused. Receipt responses are
`Cache-Control: no-store`; neither offline membership nor client cache is deletion
proof. Completion removes persisted membership entries, binding and selection for
that workspace, retains sibling proofs, and permanently refuses stale native
writes. The desktop root displays durable pending cleanup with **Retry cleanup**
across workspace unmounts. Active prepare/final requests are refused until a server-owned native completion verifier exists. Desktop headers and prepare timestamps are not completion proof. A `cleanup_pending` receipt authorizes no archival, local purge or identity removal; interrupted/restarted retries preserve all remaining data. Used/unverified Control
Plane scopes and registered devices stay blocked until their external/all-device
cleanup contract exists. Browser deletion refuses because it cannot verify
device-local resources. Shared host authentication is intentionally preserved.
