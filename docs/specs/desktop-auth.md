# Spec: desktop authentication

The native shell's half of the desktop sign-in handoff: what it accepts, what it
stores, and what it refuses. The cloud half (endpoints, Neon Auth, digest
storage) lives in [Authentication boundary](../authentication.md); this page is
the contract to read before touching `apps/desktop/src-tauri/src/auth.rs`,
`cloud.rs`, or the desktop flows in `packages/auth/src/desktop.ts`.

> **Implementation note (2026-09-12):** the desktop shell is now Electrobun
> (Bun + CEF); see [ADR 0006](../decisions/0006-browser-lanes-and-desktop-shell.md).
> Rust module paths below refer to the previous shell. Documented replacements:
> the shell implements the auth command family in
> `apps/desktop/shell/src/commands.ts` (`desktop_auth_start` opens the URL in the
> system browser; `desktop_auth_take_callback` is a single read-and-clear).
> Deep-link/URL-scheme registration for the `adea://` auth callback is not yet
> carried by the shell; release-pipeline registration is tracked in #370.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## One cloud origin

`cloud.rs` owns the origin: `DEFAULT_CLOUD_ORIGIN` plus `cloud_origin()`, which
reads the compile-time `VITE_ADEA_CLOUD_ORIGIN` that `scripts/tauri.mjs`
validated and passed to the build. The packaged CSP, this allowlist, and the
browser-safe broker all derive from that one value;
`scripts/check-desktop-origins.mjs` fails the build on any other origin literal
in the shell.

`validate_authorization_url` accepts a URL only when the scheme, host, and port
equal the cloud origin's, the path is exactly `/api/auth/desktop/authorize`,
there are no credentials and no fragment, and the query carries exactly seven
parameters: `client=desktop`, `code_challenge_method=S256`,
`redirect_uri=adea://auth/callback`, `response_type=code`, and bounded
`code_challenge`, `nonce`, and `state`. Any of `access_token`, `id_token`,
`refresh_token`, `session_token`, or `token` is rejected outright — a URL that
carries a credential never reaches the browser.

## The callback

The shell registers the `adea://` scheme and accepts a callback only when its
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

All three live in the operating-system credential store under the service
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

## IPC contract

`desktop_auth_*`, `desktop_user_session_*`, and `desktop_temporary_workspace_*`
are granted by `permissions/desktop-auth.toml` to the bundled main window only.
The registered and granted command sets must match exactly:
`src/ipc_contract.rs` and `scripts/desktop-ipc-boundary.test.ts` fail the build
otherwise, and the latter also checks that every command the client invokes is
registered and granted.

## Pinned by

- `auth.rs` unit tests: origin allowlist, callback replay and credential
  rejection, single-use callback, vault validation for all three entries.
- `cloud.rs` unit tests: the default and compile-time origins are bare origins.
- `scripts/desktop-origin-boundary.test.ts`: the canonical constant, the derived
  call sites, and no stray origin literal.
- `scripts/desktop-ipc-boundary.test.ts`: the command surface above.
