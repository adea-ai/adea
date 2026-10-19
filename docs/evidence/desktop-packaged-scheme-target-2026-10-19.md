# Desktop packaging — the generated macOS bundle's `adea` scheme and build target

A local, bounded qualification of the **packaging boundary** only: the
`Contents/Info.plist` of the _generated_ macOS bundle, and the build target the
bundle carries next to its client. Run on 2026-10-19 from an isolated worktree
at `origin/main` = `c92f162566e8c1396e6cfbdb0abbec29062147cd`.

No release was run or published, no bundle was installed or launched, no
URL-scheme delivery was invoked, and no cloud or production service was used.
The bundle and the client build stay local and ignored.

**Credential store.** This qualification performed no credential-store access of
its own, and no credential-store write was confirmed to have completed. But one
pre-existing, unrelated lane in the same session **did attempt** the operating
system credential store: `apps/desktop/tests/packaged-worktree-containment.test.ts`
reached `createCredentialVault`, whose vault key is created by
`security add-generic-password -U -s com.adea.desktop.dev-runtime -a
master-key-v1`, and that invocation **timed out** after 10 s (`the OS
credential store refused: the OS credential store did not answer in time`).
The attempt is recorded here rather than summarised as "no Keychain access";
see [Scope, stated precisely](#scope-stated-precisely) and
[Deferred gaps](#deferred-gaps).

## What was executed

```sh
bun install --frozen-lockfile
bun run --cwd apps/desktop shell:build          # local dev bundle
#   -> apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app

ADEA_DESKTOP_RELEASE_BUILD=true \
  bun run --cwd apps/desktop shell:client:build  # local release-mode client
```

Read from the generated bundle:

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' \
  apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app/Contents/Info.plist

node apps/desktop/scripts/verify-release-target.mjs < \
  apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app/Contents/Resources/app/client/adea-desktop-target.json
```

The regression coverage is `apps/desktop/tests/packaged-scheme-target.test.ts`.

### Other commands run in the same session

These are not part of this qualification's evidence; they are listed because one
of them reached the operating system credential store.

```sh
bun test tests/packaged-worktree-containment.test.ts   # reached the OS credential store; timed out
```

Its failure is pre-existing: it fails identically with this branch's diff
removed (it is a macOS Keychain-access timeout in the Dev Runtime credential
vault, not in the desktop-auth store and not in the packaging boundary). It was
**not** re-run after the review repair, per the instruction to run no further
credential-store operations; see
[Scope, stated precisely](#scope-stated-precisely).

## Results

| Step                                                          | Result                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Build                                                         | `Adea-dev.app` generated on darwin-arm64 (`bun 1.4.3`, `node 24.21.0`, Electrobun `2.0.1`)                  |
| `CFBundleURLTypes`                                            | one entry: `CFBundleURLName = dev.adea.desktop`, `CFBundleTypeRole = Viewer`, `CFBundleURLSchemes = [adea]` |
| `CFBundleURLName` vs `CFBundleIdentifier`                     | both `dev.adea.desktop`                                                                                     |
| Embedded `Resources/app/client/adea-desktop-target.json`      | `{"mode":"local","cloudOrigin":"http://localhost:3000"}`                                                    |
| Release gate vs the embedded local record                     | **refused** (exit 1): "not as a release build for https://adea.dev"                                         |
| Release-mode client build (`ADEA_DESKTOP_RELEASE_BUILD=true`) | `{"mode":"release","cloudOrigin":"https://adea.dev"}`                                                       |
| Release gate vs the release-mode record                       | **accepted** (exit 0): "release build for https://adea.dev"                                                 |
| `bun test tests/packaged-scheme-target.test.ts`               | 9 pass, 0 fail                                                                                              |

The `adea` scheme is therefore **in the built bundle**, not only declared in
`apps/desktop/shell/electrobun.config.ts`: the source declaration reaches the
generated `Info.plist`, and the bundle carries the local development target
that the existing release gate correctly refuses.

## Bundle selection (review repair)

The first version of this qualification selected its bundle with the shared
`findAppBundle` helper. That helper prefers `dev-macos-arm64/Adea-dev.app` but
then returns **any** `.app` it finds, so on a **stable-only** checkout it
returned the stable bundle — whose embedded target is the _release_ record, so
the local-mode assertion failed on a checkout that was entirely correct.

The repaired file selects the development bundle itself: by its exact packaged
path, and only after the bundle's own `Contents/Resources/version.json` says
`channel: "dev"` (read directly, because the shared `readPackagedIdentity`
falls back to `dev` when that file cannot be read, so it cannot decide that a
bundle _is_ the development build). The shared helper is left untouched, so no
other consumer changes.

The repair was verified end to end on a real stable-only checkout (the
development bundle moved aside, a stable bundle with a release record staged
in its place):

| Checkout state     | Pre-repair file                               | Repaired file                                     |
| ------------------ | --------------------------------------------- | ------------------------------------------------- |
| Development bundle | 6 pass, 0 fail                                | 9 pass, 0 fail                                    |
| Stable-only        | 3 pass, **3 fail** (`"local"` vs `"release"`) | 6 pass, 3 skip, **0 fail** (skip reported loudly) |
| No bundle          | skipped silently                              | skip reported loudly, regressions still assert    |

The stable-only and no-bundle cases are also pinned in the suite itself, so a
future change to the selection cannot silently reintroduce the failure.

## Negative control

The regression test was checked against a deliberately broken bundle, to prove
it is not a tautology. `CFBundleURLTypes` was removed from the generated
`Info.plist` and the embedded target was replaced with a release record; the
suite then reported **3 pass, 3 fail**, naming the missing scheme and the
`"release"` mode where `"local"` was required. The bundle was restored and the
suite returned to 6 pass / 0 fail. The bundle lives in an ignored build
directory; the mutation was local and left no tracked change.

## Scope, stated precisely

This proves the **shape of the generated artifact**: the macOS bundle Electrobun
produces from this repository's config registers the `adea` URL scheme in its
`Contents/Info.plist`, and the client embedded in that bundle carries the build
target the local client build recorded, which the existing release gate
refuses. The release branch of the same target contract is proved by the same
gate accepting the record a release-mode client build writes.

It does **not** prove live URL-scheme delivery. macOS hands an `adea://` URL to
an app only when that app is installed and registered with LaunchServices, and
Electrobun's own configuration note says the app must be in `/Applications` for
registration to work. Nothing here installs the bundle, registers it, or opens
a callback against it, so "the OS delivers `adea://auth/callback` to the
packaged shell" remains unproven here by design.

It does **not** prove the release lane. The `release-assets.yml` verify gate
is out of scope for this qualification and was not changed; the release record
proved here was produced by a local `ADEA_DESKTOP_RELEASE_BUILD=true` client
build, never published, signed, notarized, or installed.

### The credential store, precisely

Two different things must not be conflated:

- **This qualification** read a plist and a JSON file from a build directory
  and ran the release-target gate over a record on stdin. It made **no**
  credential-store access, and it installed **nothing**.
- **A pre-existing, unrelated lane** in the same session
  (`apps/desktop/tests/packaged-worktree-containment.test.ts`) reached
  `createCredentialVault` and attempted to create the dev-runtime vault key
  with `security add-generic-password` against service
  `com.adea.desktop.dev-runtime`, account `master-key-v1`. That invocation
  **timed out** (10 s) and the lane reported `the OS credential store refused:
the OS credential store did not answer in time`.

So the accurate statement is: no credential-store write was **confirmed** to
have completed, and no application was installed — while an OS credential-store
**write was attempted** and did not complete within the timeout. Whether the
timed-out `security` process had already committed the item before it was
killed was not observed, and is not claimed either way. The lane is unrelated
to this qualification: it exercises the Dev Runtime credential vault, not the
desktop-auth store, and its failure is pre-existing (it fails identically with
this branch's diff removed).

## Deferred gaps

- **Live install and LaunchServices delivery.** Needs the bundle installed and
  a real `adea://auth/callback` opened against it. Out of scope here; it
  belongs to the signed packaging/release lane.
- **The CI release gate does not assert the scheme.** `release-assets.yml`
  checks the bundle's binaries, CEF framework, client, sidecar, managed-Pi
  archive, icon and build target, but never `CFBundleURLTypes`. Adding that
  assertion to the CI gate was explicitly out of scope for this work; it is a
  natural follow-up once the live-install path is proven.
- **The stable-channel bundle is unproven.** Only the dev-channel bundle was
  built locally. The stable bundle is produced by the release lane.
- **The timed-out credential-store write is unverified.** The containment
  lane's `security add-generic-password` was killed at the 10 s timeout, so
  whether it left an item behind is unknown. It was not re-checked and not
  cleaned up, because no further credential-store operation was permitted for
  this repair. Inspecting the `com.adea.desktop.dev-runtime` / `master-key-v1`
  item is a follow-up for the lane's owner.
