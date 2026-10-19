# Stable build and fresh-install qualification checklist (local draft, unpublished)

Base: `origin/main` `52548ed07`. Scope 7 of the 2026-10-19 direction: stable-build,
fresh-install and release-readiness qualification of the macOS arm64 desktop
bundle. Read-only until each gate below is cleared.

## Out of scope here (owned elsewhere, not duplicated)

- OpenCode W2 (packaged selector) and W3 (probe), kept as dependency references
  only; nothing here claims their qualification: anything about the packaged
  model selector or selection, and probe scripts such as
  `apps/desktop/shell/scripts/packaged-native-auth-probe.ts` and
  `packaged-transport-defect-probe.ts`.
- Auth delivery (#1478) and the open packaged native acceptance draft (#1502).
- UI/chat/model/folder/terminal fresh-install acceptance (scope 4); see
  `docs/evidence/desktop-app-flow-acceptance-2026-10-19.md`, which records real
  installed-app execution as open there.
- Merged scheme and build-target qualification (#1486).

## A. Stable build (release lane `release-assets.yml`)

Run on this branch at `52548ed07` (desktop version 0.98.0), built locally with
`ADEA_DESKTOP_RELEASE_BUILD=true bun run shell:client:build` then
`bunx --bun electrobun build --env=stable` from `apps/desktop/shell`. Nothing was
installed or launched.

| #   | Check                                                                                                | Result                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | One `*-Adea.dmg` and one `*-Adea.app.tar.zst` come out of the stable build                           | pass: `macos-arm64-Adea.dmg` (127,576,262 bytes), `stable-macos-arm64-Adea.app.tar.zst`, plus Electrobun's unsigned `stable-macos-arm64-update.json`, which the lane must not ship                                                                   |
| A2  | Payload `version.json` version equals the release version                                            | pass: `scripts/check-desktop-payload-version.mjs` returned `0.98.0`                                                                                                                                                                                  |
| A3  | Payload carries no `*-update.json`                                                                   | pass: 0 found in the extracted payload                                                                                                                                                                                                               |
| A4  | Bundle completeness (launcher, Bun, `main.js`, client `index.html`, terminal sidecar, CEF framework) | pass: all present                                                                                                                                                                                                                                    |
| A5  | DMG is a complete UDIF image                                                                         | pass: `koly` trailer present, 127,576,262 bytes (floor is 50 MB)                                                                                                                                                                                     |
| A6  | Ad-hoc signed, not re-signed                                                                         | pass (read-only `codesign -dv`): `Signature=adhoc`, flags `0x20002(adhoc,linker-signed)`, no Team ID                                                                                                                                                 |
| A7  | Recorded build target is the release build for `https://adea.dev`                                    | pass only for a release-mode client. A plain `bun run shell:client:build` records `mode: local`, `http://localhost:3000`, and `apps/desktop/scripts/verify-release-target.mjs` rejects it, so a local default build is not a release-shaped artifact |

sha256 of the release-mode artifacts (local, not published):
`macos-arm64-Adea.dmg` 0eebe75602919b7d950d14d390580b94c6aa604f9b0e2873d451c6ae27945777;
`stable-macos-arm64-Adea.app.tar.zst` 6756f0c04fb348e560c359c6ebe1afdf64ebeb08989169f690f12d1007f05a63.

Note: one `hdiutil create` attempt failed with "No space left on device" at
free-disk pressure and passed on retry; budget about 1 GB of working space per
build.

## B. Fresh install and first launch (disposable HOME, local feed, test key)

Not re-run for this branch: it needs an app launch, which this scope does not
authorize. The "evidence" column cites runs from the #1381/#1382 qualification
(older builds); treat them as prior evidence, not as qualification of this build.

| #   | Check                                                                                                                    | Evidence that exists                            | Gap                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------- |
| B1  | DMG wrapper copy to first launch; app serves its loopback UI                                                             | #1382 receipts: control and PR builds, HTTP 200 | Repeat on current main build                      |
| B2  | Data directory created with owner-only modes on first launch                                                             | Observed `drwx------` data dir in #1382 runs    | Record modes explicitly                           |
| B3  | Relaunch persistence (state survives a second launch)                                                                    | Not measured                                    | Add: write marker via bridge, relaunch, read back |
| B4  | Installer leaves `uninstall` and `.electrobun-uninstall.json`; second installer run replaces `self-extraction` wholesale | Observed in #1382 control run                   | Document as Electrobun behaviour                  |
| B5  | Installer's retained tar is retired for the running build only                                                           | #1382 (merged) receipts                         | Re-confirm on current main                        |

## C. Update lifecycle

| #   | Check                                                                                           | Evidence                                                  | Gap                                                                     |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| C1  | Full, slim, stable-to-dev and dev-to-stable hops relaunch correctly                             | #1382 receipts (0.94.0 → 0.94.1-dev.7 slim → 0.94.1 full) | Repeat once on current main                                             |
| C2  | Runtime-hash mismatch falls back to the full archive                                            | Not exercised                                             | Build a feed whose `runtime.sha256` differs; expect full download       |
| C3  | Unapproved, corrupted-archive and tampered-signature updates are refused with no state change   | #1382 receipts                                            | none                                                                    |
| C4  | Apply-script failure paths (#1381): full-swap rollback, slim failure stops, no relaunch         | #1381 receipts                                            | none; note "no relaunch" user impact                                    |
| C5  | Rollback executor restores a packaged layout                                                    | #1382 receipts                                            | Note: no production caller exists                                       |
| C6  | `ADEA_UPDATE_FEED` override applies only on the stable channel (spec says it wins over channel) | Observed 2026-10-15                                       | Re-check on current main; report as spec/code mismatch if still present |

## D. Release-readiness gaps (named, not attempted)

| #   | Gap                                                                          | Gate                                                                                               |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| D1  | Quarantined DMG install (Gatekeeper behaviour on a downloaded ad-hoc image)  | Needs a real downloaded DMG and a real install; no install until separately cleared                |
| D2  | Notarization / Apple signing                                                 | Out of scope; signing action not authorized                                                        |
| D3  | Real macOS keychain behaviour of the unmodified vault                        | Needs native-credential action; not authorized (qualification runs use an in-memory vault overlay) |
| D4  | CEF profile path ignores `HOME` (written under the real Application Support) | Isolation caveat for any disposable run; use a unique identifier and delete only that folder       |
| D5  | Release-lane claims in `docs/releasing.md` vs current workflow               | Read-only diff of doc against `release-assets.yml`                                                 |

## Ground rules

No release, signing, install on the user's machine, native-credential action,
push, readiness change or merge. All runs use a throwaway HOME, a unique app
identifier, a local signed feed with a test key and a PATH-first `open` shim,
and verify the user's real Adea and Application Support are unchanged before
and after.
