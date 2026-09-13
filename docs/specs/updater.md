# Spec: desktop updater

How the desktop shell receives signed updates. This page is the contract to read
before touching `apps/desktop/src-tauri/src/updater.rs`, the updater block in
`tauri.conf.json`, or `.github/workflows/release-assets.yml`.

> **Implementation note (2026-09-12):** the desktop shell is now Electrobun
> (Bun + CEF); see [ADR 0006](../decisions/0006-browser-lanes-and-desktop-shell.md).
> Rust module paths below refer to the previous shell. There is no auto-update
> lane in the shell yet: `desktop_update_check` / `desktop_update_status` in
> `apps/desktop/shell/src/commands.ts` return `upToDate`, and release-lane work
> is tracked in #370.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## Release channel

Updates are published to this repository's GitHub Releases; there is no separate
update server. The shell polls

```
https://github.com/adea-ai/adea/releases/latest/download/latest.json
```

which is written by the release lane (`tauri-action`) from the signed artifacts.
The channel is fixed in `tauri.conf.json` (`plugins.updater.endpoints`) and is a
baselined exception in `scripts/check-desktop-origins.mjs`: the only origin the
app talks to besides the cloud origin is the one it updates from.

## Trust chain

- Release artifacts are signed with the project's Tauri signing key. The private
  key exists only as the repository secret `TAURI_SIGNING_PRIVATE_KEY` (with its
  password), consumed by `.github/workflows/release-assets.yml`.
- The public key is baked into the app at build time
  (`plugins.updater.pubkey`) and is the only key the plugin trusts. A package
  that does not verify against it is refused before installation.
- macOS builds additionally carry `APPLE_SIGNING_IDENTITY`; local builds sign
  with the machine's stable `adea-local-codesign` identity so keychain grants
  survive rebuilds (see `apps/desktop/scripts/tauri.mjs`).

## User-visible policy

- `dialog: false`: the plugin never shows its own dialog. Updates are surfaced
  through the app's own version dialog, which reports phase, progress, release
  notes, and the release page (`github_url`).
- Installation requires explicit approval: `desktop_update_install` refuses
  without `approved: true`, and refuses a version that is not the pending one or
  is malformed, so a stale confirmation cannot install a different release.
- Restart happens only when the caller asks for it (`restart: true`).
- The bundled `CHANGELOG.md` is what the dialog shows when no release notes are
  available, bounded to 32,000 characters.

## State machine

`idle → checking → available | current | failed`, then
`available → downloading → installing → installed | failed`.

- A failed install keeps the pending update, so a retry does not repeat the
  check.
- A download that exceeds 30 minutes fails with an explicit timeout message.
- `installed` sets `restart_required`; the app keeps running until asked.
- The snapshot always reports the running version from package info, not from
  the last check.

## Boot integration

The updater plugin is registered by the boot pipeline, not by an ad-hoc setup
closure: a shell that cannot load its updater reports
`nativeServiceUnavailable` with guidance instead of starting silently unable to
update (see `apps/desktop/src-tauri/src/boot.rs` and the boot boundary test).

## Pinned by

- `updater.rs` unit tests: the install guard (approval, version match, malformed
  version), a release-notes budget in characters, and the bundled changelog as
  plain text.
- `scripts/desktop-ipc-boundary.test.ts`: the `desktop_update_*` command surface
  and its grant.
- `.github/workflows/desktop-shell.yml`: `cargo test` for the crate, including
  the tests above.
- `.github/workflows/release-assets.yml` and `scripts/release-notes.mjs`: the
  published notes are validated before the release is edited.
