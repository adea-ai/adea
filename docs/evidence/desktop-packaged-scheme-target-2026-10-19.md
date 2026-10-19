# Desktop packaging — the generated macOS bundle's `adea` scheme and build target

A local, bounded qualification of the **packaging boundary** only: the
`Contents/Info.plist` of the _generated_ macOS bundle, and the build target the
bundle carries next to its client. Run on 2026-10-19 from an isolated worktree
at `origin/main` = `c92f162566e8c1396e6cfbdb0abbec29062147cd`.

No release was run or published, no bundle was installed or launched, no
Keychain or credential was touched, no URL-scheme delivery was invoked, and no
cloud or production service was used. The bundle and the client build stay
local and ignored.

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
| `bun test tests/packaged-scheme-target.test.ts`               | 6 pass, 0 fail                                                                                              |

The `adea` scheme is therefore **in the built bundle**, not only declared in
`apps/desktop/shell/electrobun.config.ts`: the source declaration reaches the
generated `Info.plist`, and the bundle carries the local development target
that the existing release gate correctly refuses.

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
