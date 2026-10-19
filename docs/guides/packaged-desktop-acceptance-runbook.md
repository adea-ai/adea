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

| Status            | Meaning                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SOURCE-VERIFIED` | The claim is covered by a test that reads only source or local build artifacts. It was run **on this head**.     |
| `INHERITED`       | The claim's evidence was produced on a **cited, already-merged exact head**. It was **not** re-run on this head. |
| `PENDING`         | The lane is specified and permitted here; it was **not** executed on this head.                                  |
| `BLOCKED`         | The claim needs a step this environment must not perform. The command is specified; it was **not** run.          |
| `MISSING LANE`    | The claim has no lane at all. The lane must be written before the claim can even be attempted.                   |

`SOURCE-VERIFIED` never means "the shipped product does this". It means a
source-level or build-artifact-level proof exists and passes.

## Acceptance items

| ID  | Claim                                                                                                      | Lane / command (working directory)                                                                        | Status            |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------- |
| A1  | A freshly built macOS bundle registers the `adea` callback scheme and carries a build target               | `bun test tests/packaged-scheme-target.test.ts` (apps/desktop) — inherited from #1486                     | `INHERITED`       |
| A2  | A release-mode build records the release target, and the release gate accepts only that                    | release-mode client build + `verify-release-target.mjs` (repository root) — inherited from #1486          | `INHERITED`       |
| A3  | The release lane's own gate refuses a non-release build                                                    | `bun test scripts/release-target-verifier.test.ts` (repository root)                                      | `SOURCE-VERIFIED` |
| A4  | The installer retires only its own payload tar, and never an unsafe path                                   | `bun test tests/installer-archive.test.ts` (apps/desktop)                                                 | `SOURCE-VERIFIED` |
| A5  | The packaged containment lane never reaches the OS credential store                                        | `bun test tests/packaged-worktree-credential-isolation.test.ts` (apps/desktop)                            | `SOURCE-VERIFIED` |
| A6  | The containment lane's own packaged run (real worktrees, real registrar)                                   | `bun apps/desktop/shell/scripts/packaged-worktree-smoke.ts --app-bundle <Adea-dev.app>` (repository root) | `PENDING`         |
| A7  | The Dev Runtime vault really works against the macOS Keychain                                              | `bun run test:packaged:vault` (repository root) — disposable `com.adea.m10.vault.<UUID>` services         | `BLOCKED`         |
| A8  | The desktop-auth vault really works against the macOS Keychain (`com.adea.desktop`)                        | — no lane exists                                                                                          | `MISSING LANE`    |
| A9  | macOS actually hands `adea://auth/callback` to the installed app                                           | install to `/Applications`, then `open 'adea://auth/callback?…'` (host shell)                             | `BLOCKED`         |
| A10 | A real account can sign in through the cloud and the session is persisted in the OS store                  | — no lane exists                                                                                          | `MISSING LANE`    |
| A11 | The packaged owner journey (project, worktree, runtime session, archive) over a disposable real repository | `bun run test:packaged:owner-journey` (repository root)                                                   | `PENDING`         |

## Per-item detail

Every command below states its working directory. The two directories are the
**repository root** and **`apps/desktop`**; a `tests/…` path means the latter,
a `scripts/…` path means the former.

### A1 — Fresh-bundle scheme and build target `INHERITED`

**Inherited, not re-run on this head.** The evidence was produced on the merged
PR #1486, head `3eaf0e45838e2b2ac805680702c0fb63b878a4af`, merged as
`4505c88473e1d29b4df67497c6561974d05378df`; that PR's lane file is
`apps/desktop/tests/packaged-scheme-target.test.ts`. This branch does not
contain that file, does not modify it, and did not re-run the build it needs.

Working directory: **repository root**.

```sh
bun run --cwd apps/desktop shell:build
# -> apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app
```

Read the bundle's own `Contents/Info.plist` and the client target it carries.
Working directory: **repository root**.

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' \
  apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app/Contents/Info.plist
cat apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app/Contents/Resources/app/client/adea-desktop-target.json
```

Working directory: **apps/desktop**.

```sh
bun test tests/packaged-scheme-target.test.ts
```

The lane asserts `CFBundleURLTypes` → `CFBundleURLSchemes` contains `adea`,
that the URL type is named after the bundle identifier, and that the embedded
target is the **local** development target that the release gate refuses.

Proves: the generated bundle's shape. Does **not** prove: that macOS hands the
URL to the app (that is A9).

### A2 — Release target `INHERITED`

**Inherited, not re-run on this head**, from the same merged #1486 exact head
as A1.

Working directory: **repository root**.

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

Working directory: **repository root**.

```sh
bun test scripts/release-target-verifier.test.ts
```

It runs the **actual** `release-assets.yml` verify snippets against a
synthetic payload. It proves the gate's logic, not the gate against a real
release artifact. Run on this head.

### A4 — Installer archive retention `SOURCE-VERIFIED`

Working directory: **apps/desktop**.

```sh
bun test tests/installer-archive.test.ts
```

It stages a real on-disk layout and covers the removal, the stable→dev upgrade
shape, the prepared-update hands-off, the symlink refusal, and the
unsafe-identity refusal. The install-location resolution it depends on is
[`packaged-install.ts`](../../apps/desktop/shell/scripts/packaged-install.ts).
Run on this head.

### A5 — Containment-lane credential isolation `SOURCE-VERIFIED`

Working directory: **apps/desktop**.

```sh
bun test tests/packaged-worktree-credential-isolation.test.ts
```

It proves that the packaged containment lane
([`packaged-worktree-smoke.ts`](../../apps/desktop/shell/scripts/packaged-worktree-smoke.ts))
never reaches the OS credential store: its vault is built through
`createLaneCredentialVault` with an injected in-memory store, and every
`createCredentialVault` call in the lane names a `credentialStore`.

Proves: the lane's credential path cannot reach a native backend. Does **not**
prove: the lane's containment proofs (that is A6). Run on this head.

### A6 — The containment lane's own packaged run `PENDING`

**This is host-side execution, not an app install and not an app launch.** The
lane runs the shell's own modules in a **temporary** directory against a
locally built bundle: it creates real git worktrees under a disposable
temporary root, drives the production registrar over the M10 channel authority,
and writes its artifact under `apps/desktop/artifacts/packaged/`. It does not
install the app, does not launch the app, does not open a browser, and — after
A5's repair — does not reach the OS credential store.

Working directory: **repository root**.

```sh
bun apps/desktop/shell/scripts/packaged-worktree-smoke.ts \
  --app-bundle apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app
# artifact: apps/desktop/artifacts/packaged/worktree-containment.json
# verdict:  PACKAGED-WORKTREE-CONTAINMENT PASS
```

It proves the escape refusals (`symlink_rejected`, `identity_mismatch`,
`stale_generation`) plus that an escape target is left untouched.

**Pending, not blocked:** the only thing it needs is a locally built bundle
and a host that may run the lane's temporary worktrees. Its earlier run in
another session failed at the credential store (see
[the credential-store account](#the-credential-store-account)); A5 removes that
reach, so the lane is now runnable without native-credential clearance. It was
**not** executed on this head.

### A7 — True-keychain Dev Runtime vault `BLOCKED`

Working directory: **repository root**.

```sh
bun run test:packaged:vault
# -> scripts/test-m10-33-packaged-vault.mjs
# artifact: artifacts/packaged/m10-33-vault-evidence.json
```

The probe is
[`packaged-vault-smoke.ts`](../../apps/desktop/shell/scripts/packaged-vault-smoke.ts);
it runs inside a packaged bundle's own Bun and drives the production vault
adapter against the macOS `security` CLI and Bun's native secret slot.

**Service isolation.** The wrapper
([`test-m10-33-packaged-vault.mjs`](../../scripts/test-m10-33-packaged-vault.mjs))
mints a **disposable** service id — `com.adea.m10.vault.<UUID>` — and passes it
to the probe as `ADEA_M10_VAULT_SERVICE_ID`. The probe derives its slots from
that base (`…journey`, `…denied`, `…locked`, `…mismatch`, plus a `.bun`
counterpart), and the wrapper deletes exactly those slots afterwards. So this
lane exercises the real Keychain **without** writing the production
`com.adea.desktop.dev-runtime` service. It is a disposable-service probe, and
it proves nothing about the production service's own items.

**Blocked because:** it performs native credential-store reads and writes, even
though they are disposable ones.

### A8 — True-keychain desktop-auth vault `MISSING LANE`

The three desktop-auth vault entries live in the OS credential store under
service `com.adea.desktop`
([`desktop-auth-store.ts`](../../apps/desktop/shell/src/desktop-auth-store.ts)):
`desktop-authorization-attempt`, `desktop-user-session`, and
`temporary-workspace-session`.

**No lane exists for this service.** `com.adea.desktop` appears only in the
store implementation and in the spec. A7 does not cover it either: A7 probes
**disposable** `com.adea.m10.vault.<UUID>` services, not `com.adea.desktop`
and not the production `com.adea.desktop.dev-runtime` service. A packaged
probe for `com.adea.desktop` — mirroring A7's disposable-service pattern, with
redacted output only — has to be written before the claim can be attempted at
all.

**Blocked because:** the lane is missing, and any lane that exists would
perform native credential-store access.

### A9 — OS callback registration `BLOCKED`

The bundle carries the registration entry (A1). macOS only hands an `adea://`
URL to an app that is **installed and registered with LaunchServices**, and
Electrobun's own configuration note says the app must be in `/Applications`
for registration to work. The proof would be: install the bundle, `open
'adea://auth/callback?code=…&nonce=…&state=…'`, and observe the shell's
`open-url` event and the `desktop-state/auth-callback.json` handoff.

**Blocked because:** it requires installing and launching the app.

### A10 — Real sign-in and OS-store persistence `MISSING LANE`

**No lane covers this claim.** `bun run test:packaged:owner-journey` is **not**
evidence for it: that lane is a host-side project/worktree/runtime-session/
archive journey over a disposable real repository, with a synthetic UUID scope,
and it composes the browser-matrix artifact rather than driving a browser. It
performs **no** desktop login, **no** cloud authentication, and **no**
desktop-auth store verification. It is described on its own in A11.

What exists today is source-level only, and is not a substitute:

| Coverage                                                                         | What it is                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/auth/tests/unit`                                                       | PKCE, origin and codec contract, in memory                   |
| [`auth-lifecycle.ts`](../../scripts/fresh-postgres-acceptance/auth-lifecycle.ts) | cloud auth lifecycle, with memory-only persistence by design |
| `apps/desktop/tests/desktop-auth-store.test.ts`                                  | the desktop-auth store, over an **in-memory** keychain port  |

None of them signs in against a real account, and none of them writes the
`desktop-user-session` entry to the OS credential store. A lane that did would
have to drive the real sign-in handoff and then read the real
`com.adea.desktop` item back — native credential access, and a real account.

**Blocked because:** the lane does not exist, and writing it needs both a
real-account clearance and native-credential clearance.

### A11 — The packaged owner journey `PENDING`

Working directory: **repository root**.

```sh
bun run test:packaged:owner-journey
# -> apps/desktop/shell/scripts/packaged-owner-journey.ts
# artifact: artifacts/packaged/owner-journey.json
```

This is a **host-side** lane: it exercises the production project, worktree,
runtime-session, and archive authorities against a disposable real Git
repository while anchoring the run to a locally built bundle. Its browser leg
is **composed** from the browser-matrix artifact rather than re-driven. It
proves the owner journey's project/worktree/session/archive surface — **not**
sign-in, **not** cloud authentication, and **not** desktop-auth persistence
(A10).

**Pending, not blocked:** it needs a locally built bundle and the
browser-matrix artifact, both local. It was **not** executed on this head.

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
**not established**, and is not claimed either way. That service is the
production Dev Runtime vault service the containment lane's vault would use —
distinct from the disposable `com.adea.m10.vault.<UUID>` services A7 uses.

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

## Items not yet executed, and what each one needs

| ID  | State          | What it needs                                                                                                                             |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A6  | `PENDING`      | A locally built bundle and a host that may run the lane's temporary worktrees. No native credential access, no install, no launch.        |
| A7  | `BLOCKED`      | A machine cleared for native credential-store access. The lane's own services are disposable (`com.adea.m10.vault.<UUID>`).               |
| A8  | `MISSING LANE` | First the lane (source only), then the same native-credential clearance as A7.                                                            |
| A9  | `BLOCKED`      | A machine cleared for live install; the bundle must not be re-signed (see the updater spec).                                              |
| A10 | `MISSING LANE` | First the lane (source only), then an explicitly authorized test account, a non-production cloud target, and native-credential clearance. |
| A11 | `PENDING`      | A locally built bundle and the browser-matrix artifact, both local.                                                                       |

Until each clearance exists, the corresponding row keeps its status and no
document may report it as proved.

## What was executed to prepare this runbook

Source-level and local build-artifact inspection only. No keychain or
`security` command was run, no application was installed or launched, no
browser was opened, no real account, credential, or production service was
used, and no lane that reaches a native credential backend was executed.

**Run on this head.** Working directory: **repository root**.

```sh
bun install --frozen-lockfile
bun run build:web-deps
bun test scripts/docs-boundary.test.ts
bun test scripts/release-target-verifier.test.ts          # A3
bun test scripts/desktop-auth-boundary.test.ts
bun test scripts/desktop-ipc-boundary.test.ts
bun test scripts/desktop-origin-boundary.test.ts
```

Working directory: **apps/desktop**.

```sh
bun test tests/packaged-worktree-credential-isolation.test.ts   # A5
bun test tests/packaged-acceptance-runbook.test.ts
bun test tests/dev-runtime-vault-keychain.test.ts                # pure classification
bun test tests/dev-runtime-vault-bun-secrets.test.ts             # fake native slot
bun test tests/dev-runtime-vault-key-roles.test.ts               # injected runner
bun test tests/dev-runtime-grants.test.ts                        # injected store
bun test tests/worktree-service.test.ts                          # containment source
bun test tests/worktree-include-copy.test.ts
bun test tests/worktree-merge.test.ts
bun test tests/worktree-bootstrap-leases-templates.test.ts
bun test tests/installer-archive.test.ts                         # A4
bun test tests/update-manager.test.ts
```

**Not executed on this head** (inherited or pending): A1 and A2 are inherited
from merged #1486 (see their sections); A6 and A11 need a locally built
bundle; A7 and A9 are blocked; A8 and A10 have no lane.

**Deliberately not executed:** `tests/packaged-worktree-containment.test.ts`
(it runs the A6 lane), `bun run test:packaged:vault` (A7, native credential
access), `bun run test:packaged:owner-journey` (A11, needs a local bundle).
