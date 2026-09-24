# M12/#610 — packaged-runtime cookie read

The #610 acceptance ends with: "Fixture-only work cannot close the packaged
acceptance clause on #422: reading a **real** profile from the packaged macOS
build is part of this issue." This is that verification, run on 2026-09-23.

## What was executed

```sh
/Applications/Adea.app/Contents/MacOS/bun \
  apps/desktop/shell/scripts/packaged-cookie-read.ts
```

The binary that ships inside the installed app (`Bun 1.4.0`, Electrobun bundle)
runs the shell's own reader module. The report is retained beside this file
(`m12-610-packaged-cookie-read-2026-09-23.json`); it carries counts, kinds, and
typed states only — no cookie value is read into it, printed, or written
anywhere but the temp profile described below.

## Results

| Step                                           | Result                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Runtime                                        | `Bun 1.4.0`, `platform: darwin`, `argv0: /Applications/Adea.app/Contents/MacOS/bun`                             |
| Detection                                      | `chrome:Default`, `brave:Default`, a Firefox profile — `available`; `safari:legacy` — `unsupported_format`      |
| Real read (Chrome profile, real Keychain item) | **625 cookies, 74 partitioned, 615 with expiry**, SameSite states `lax / no_restriction / strict / unspecified` |
| The app's own lane profiles                    | both `adea-browser-profile-v1-…` profiles read (`0` cookies — no lane has set one yet)                          |
| Write target (`Chromium Safe Storage`)         | available; round trip `true`; SameSite preserved `true`; partition preserved `true`                             |

The real-read figures are identical to the same profile read through the repo's
Bun, and identical to the profile's own SQL counters (`74` rows carry a
partition key, `615` carry `has_expires = 1`) computed independently.

## Scope, stated precisely

This proves the **shipped runtime** performs the whole read: `bun:sqlite` is
present in the packaged Bun, `/usr/bin/security` is spawnable from it, the OS
decryption path is intact, and the app's own Chromium profile schema is readable
by the reader. It is the same binary and the same module the app runs in
production.

It does **not** drive the app's own process/IPC path (signed-in workspace →
Dev View → cookie-import flow), because that path has no UI yet: the operations,
the policy, the transactional applier, the reader, and the profile store are
implemented and tested, and the client surface for them is filed as follow-up
work. Stating it that way is the difference between "the packaged runtime can do
this" (verified here) and "a user can do this from the packaged app" (not yet).

## Why the Keychain item is the one it is

The lane WebView is Chromium-backed — the same build writes the Chromium profile
schema (`has_cross_site_ancestor` included) and speaks CDP. On macOS that build
names its Keychain item from its product name. Verified on this machine: an item
with service `Chromium Safe Storage` and account `Chromium`, created at the
runtime's first launch (2026-09-12), whose derived key round-trips a value
through the store. `CHROMIUM_LANE_KEYCHAIN_SERVICE` therefore defaults to it,
and every lane kind the Chromium-backed engine serves (`human_embedded`,
`task_owned`, `user_context`) is a writable cookie-store target.
