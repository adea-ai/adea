# Packaged desktop acceptance runbook

The exact test and lane coverage for the packaged desktop's acceptance claims,
and the exact point at which each claim is currently blocked.

This runbook **authorizes nothing**. It records what must be run, against
what, and what each run proves — and, where a step cannot be run safely in
this environment, it says so and names the clearance the step needs. A step
marked `BLOCKED` has **not** been executed, and nothing in this document is
evidence that it was.

The desktop auth contract these claims belong to is
[the desktop-auth spec](../specs/desktop-auth.md); the release channel they
ship through is [the updater spec](../specs/updater.md); the Dev Runtime
worktree contract the containment lane proves is
[the dev-runtime spec](../specs/dev-runtime.md).

## Status vocabulary

| Status            | Meaning                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `SOURCE-VERIFIED` | The claim is covered by a test or inspection that reads only source or local build artifacts. It was run. |
| `BLOCKED`         | The claim needs a step this environment must not perform. The command is specified; it was **not** run.   |
| `MISSING LANE`    | The claim has no lane at all. The lane must be written before the claim can even be attempted.            |

`SOURCE-VERIFIED` never means "the shipped product does this". It means a
source-level or build-artifact-level proof exists and passes.

## Acceptance items

| ID  | Claim                                                                                        | Lane / command                                                                                                | Status            |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------- |
| A1  | A freshly built macOS bundle registers the `adea` callback scheme and carries a build target | `bun run --cwd apps/desktop shell:build`, then `bun test tests/packaged-scheme-target.test.ts`                | `SOURCE-VERIFIED` |
| A2  | A release-mode build records the release target, and the release gate accepts only that      | `ADEA_DESKTOP_RELEASE_BUILD=true bun run --cwd apps/desktop shell:client:build` + `verify-release-target.mjs` | `SOURCE-VERIFIED` |
| A3  | The release lane's own gate refuses a non-release build                                      | `bun test scripts/release-target-verifier.test.ts`                                                            | `SOURCE-VERIFIED` |
| A4  | The installer retires only its own payload tar, and never an unsafe path                     | `bun test tests/installer-archive.test.ts`                                                                    | `SOURCE-VERIFIED` |
| A5  | The packaged containment lane never reaches the OS credential store                          | `bun test tests/packaged-worktree-credential-isolation.test.ts`                                               | `SOURCE-VERIFIED` |
| A6  | The containment lane's own packaged run (real worktrees, real registrar)                     | `bun apps/desktop/shell/scripts/packaged-worktree-smoke.ts --app-bundle <Adea-dev.app>`                       | `BLOCKED`         |
| A7  | The Dev Runtime vault really works against the macOS Keychain                                | `bun run test:packaged:vault`                                                                                 | `BLOCKED`         |
| A8  | The desktop-auth vault really works against the macOS Keychain (`com.adea.desktop`)          | — no lane exists                                                                                              | `MISSING LANE`    |
| A9  | macOS actually hands `adea://auth/callback` to the installed app                             | install to `/Applications`, then `open 'adea://auth/callback?…'`                                              | `BLOCKED`         |
| A10 | A real account can sign in end to end and the session is persisted in the OS store           | `bun run test:packaged:owner-journey`                                                                         | `BLOCKED`         |

## Per-item detail

### A1 — Fresh-bundle scheme and build target `SOURCE-VERIFIED`

Build the development bundle and read the generated artifact:

```sh
bun run --cwd apps/desktop shell:build
# -> apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app
```

Read the bundle's own `Contents/Info.plist` and the client target it carries:

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' \
  apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app/Contents/Info.plist
cat apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app/Contents/Resources/app/client/adea-desktop-target.json
```

The regression lane is `apps/desktop/tests/packaged-scheme-target.test.ts`
(carried by PR #1486; it is not on `main` yet, and this runbook does not
modify it). It asserts `CFBundleURLTypes` → `CFBundleURLSchemes` contains
`adea`, that the URL type is named after the bundle identifier, and that the
embedded target is the **local** development target that the release gate
refuses.

Proves: the generated bundle's shape. Does **not** prove: that macOS hands
the URL to the app (that is A9).

### A2 — Release target `SOURCE-VERIFIED`

```sh
ADEA_DESKTOP_RELEASE_BUILD=true bun run --cwd apps/desktop shell:client:build
node apps/desktop/scripts/verify-release-target.mjs < \
  apps/web/dist-desktop/client/adea-desktop-target.json
```

The gate is [`verify-release-target.mjs`](../../apps/desktop/scripts/verify-release-target.mjs);
it accepts only `{"mode":"release","cloudOrigin":"https://adea.dev"}` and
refuses a local or hosted-development record. A local build must be refused —
that refusal is the proof that a locally built bundle can never pass the
release check.

### A3 — The release lane's own gate `SOURCE-VERIFIED`

`bun test scripts/release-target-verifier.test.ts` runs the **actual**
`release-assets.yml` verify snippets against a synthetic payload. It proves the
gate's logic, not the gate against a real release artifact.

### A4 — Installer archive retention `SOURCE-VERIFIED`

`bun test tests/installer-archive.test.ts` stages a real on-disk layout and
covers the removal, the stable→dev upgrade shape, the prepared-update hands-off,
the symlink refusal, and the unsafe-identity refusal. The install-location
resolution it depends on is
[`packaged-install.ts`](../../apps/desktop/shell/scripts/packaged-install.ts).

### A5 — Containment-lane credential isolation `SOURCE-VERIFIED`

`bun test tests/packaged-worktree-credential-isolation.test.ts` proves that the
packaged containment lane
([`packaged-worktree-smoke.ts`](../../apps/desktop/shell/scripts/packaged-worktree-smoke.ts))
never reaches the OS credential store: its vault is built through
`createLaneCredentialVault` with an injected in-memory store, and every
`createCredentialVault` call in the lane names a `credentialStore`.

Proves: the lane's credential path cannot reach a native backend. Does **not**
prove: the lane's containment proofs (that is A6).

### A6 — The containment lane's own packaged run `BLOCKED`

The lane that proves containment:

```sh
bun apps/desktop/shell/scripts/packaged-worktree-smoke.ts \
  --app-bundle apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app
# artifact: apps/desktop/artifacts/packaged/worktree-containment.json
# verdict:  PACKAGED-WORKTREE-CONTAINMENT PASS
```

It creates real git worktrees under a disposable root, runs the production
registrar over the M10 channel authority, and proves the escape refusals
(`symlink_rejected`, `identity_mismatch`, `stale_generation`) plus that an
escape target is left untouched.

**Blocked because:** it spawns real processes and needs a packaged bundle, and
before A5's repair its credential vault fell through to the OS credential store
(see [the credential-store account](#the-credential-store-account)). Running it
here is a live-install-shaped operation.

### A7 — True-keychain Dev Runtime vault `BLOCKED`

```sh
bun run test:packaged:vault
# -> scripts/test-m10-33-packaged-vault.mjs
# artifact: artifacts/packaged/m10-33-vault-evidence.json
```

The probe is
[`packaged-vault-smoke.ts`](../../apps/desktop/shell/scripts/packaged-vault-smoke.ts);
it runs inside a packaged bundle's own Bun and drives the production vault
adapter against the macOS `security` CLI and Bun's native secret slot, for
service `com.adea.desktop.dev-runtime` and its `.bun` counterpart.

**Blocked because:** it performs native credential-store reads and writes.

### A8 — True-keychain desktop-auth vault `MISSING LANE`

The three desktop-auth vault entries live in the OS credential store under
service `com.adea.desktop`
([`desktop-auth-store.ts`](../../apps/desktop/shell/src/desktop-auth-store.ts)):
`desktop-authorization-attempt`, `desktop-user-session`, and
`temporary-workspace-session`.

**No lane exists for this service.** `com.adea.desktop` appears only in the
store implementation and in the spec; the A7 probe covers a _different_
service (`com.adea.desktop.dev-runtime`). A packaged probe for this service —
mirroring A7, against a disposable service id, with redacted output only —
has to be written before the claim can be attempted at all.

**Blocked because:** the lane is missing, and any lane that exists would
perform native credential-store access.

### A9 — OS callback registration `BLOCKED`

The bundle carries the registration entry (A1). macOS only hands an
`adea://` URL to an app that is **installed and registered with
LaunchServices**, and Electrobun's own configuration note says the app must be
in `/Applications` for registration to work. The proof would be: install the
bundle, `open 'adea://auth/callback?code=…&nonce=…&state=…'`, and observe the
shell's `open-url` event and the `desktop-state/auth-callback.json` handoff.

**Blocked because:** it requires installing and launching the app.

### A10 — Real login `BLOCKED`

```sh
bun run test:packaged:owner-journey
# -> apps/desktop/shell/scripts/packaged-owner-journey.ts
```

The cloud half of the handoff is covered at source level by
[`auth-lifecycle.ts`](../../scripts/fresh-postgres-acceptance/auth-lifecycle.ts)
and by `packages/auth/tests/unit`, neither of which involves a real account.

**Blocked because:** it needs a real account, real credentials, and a cloud
service. No real account, credential, or production service is used here.

## The credential-store account

Two things must not be conflated, and one hypothesis must not be promoted to a
finding.

**What is established.** In an earlier qualification session, the packaged
containment lane was executed with the defect A5 repairs. Its vault was built
with `createCredentialVault` and no `credentialStore`, so the production vault
fell through to `createSystemVaultKeyStore()` and shelled out to
`/usr/bin/security`. The specific invocation was a **write** —
`add-generic-password -U -s com.adea.desktop.dev-runtime -a master-key-v1` —
and it was reported as `the OS credential store refused: the OS credential store
did not answer in time`, which is the vault's own timeout classification (its
`security` invocation is bounded at 10 s).

So: an OS credential-store **write was attempted** and did not complete within
the timeout. No write was **confirmed** to have landed. Whether the timed-out
`security` process had already committed the item before it was killed is
**not established**, and is not claimed either way.

**What is not established — the cause.** The lane's output records a timeout,
and nothing more. A Keychain or browser consent dialog appearing on the
operator's screen is a **hypothesis, not a confirmed cause**: no dialog was
observed by the lane, no dialog was recorded, and a timeout is equally
consistent with a blocked prompt, a locked keychain, a slow or unavailable
`security` binary, or the process being killed. Do not report this as "a
Chrome dialog blocked the keychain". The cause is unconfirmed.

**What changed.** A5 removes the attempt from this path entirely: the
containment lane's vault is backed by an in-memory store, so the lane cannot
reach a native backend. The production vault in
[`vault.ts`](../../apps/desktop/shell/src/dev-runtime/vault.ts) is unchanged and
still reaches the system keychain when no store is injected — the true-keychain
lane (A7) and the production app are unaffected.

**Not done here.** The possibly-left-behind `com.adea.desktop.dev-runtime` /
`master-key-v1` item was not inspected, removed, or reset: inspecting it is
itself a credential-store operation. It is a follow-up for the owner of that
lane, on a machine cleared for native credential access.

## Blocked items and the clearance each needs

| ID  | Blocked on                                                       | Clearance required                                                                          |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A6  | Real process spawn and a packaged bundle; prior credential reach | A packaged bundle built locally, and a machine cleared for packaged-lane execution          |
| A7  | Native credential-store reads and writes                         | A machine cleared for native credential-store access, with a disposable service id          |
| A8  | The lane does not exist, and would need native access            | First the lane (source only), then the same native-credential clearance as A7               |
| A9  | Installing and launching the app                                 | A machine cleared for live install; the bundle must not be re-signed (see the updater spec) |
| A10 | A real account, real credentials, and a cloud service            | An explicitly authorized test account and a non-production cloud target                     |

Until each clearance exists, the corresponding row stays `BLOCKED` and no
document may report it as proved.

## What was executed to prepare this runbook

Source-level and local build-artifact inspection only. No keychain or
`security` command was run, no application was installed or launched, no
browser was opened, no real account, credential, or production service was
used, and no lane that reaches a native credential backend was executed.

```sh
bun install --frozen-lockfile
bun test tests/packaged-worktree-credential-isolation.test.ts   # A5
bun test tests/dev-runtime-vault-keychain.test.ts                 # pure classification
bun test tests/dev-runtime-vault-bun-secrets.test.ts              # fake native slot
bun test tests/dev-runtime-vault-key-roles.test.ts                # injected runner
bun test tests/dev-runtime-grants.test.ts                        # injected store
bun test tests/worktree-service.test.ts                          # containment source
bun test tests/worktree-include-copy.test.ts
bun test tests/worktree-merge.test.ts
bun test tests/worktree-bootstrap-leases-templates.test.ts
bun test tests/installer-archive.test.ts                         # A4
bun test scripts/release-target-verifier.test.ts                  # A3
```

Deliberately not executed: `tests/packaged-worktree-containment.test.ts` (it
runs the A6 lane), `bun run test:packaged:vault` (A7), and
`bun run test:packaged:owner-journey` (A10).
