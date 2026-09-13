# Spec: desktop updater

How the desktop shell keeps itself current. This page is the contract to read
before touching `apps/desktop/shell/src/commands.ts` (the
`desktop_update_*` command family) or the desktop release lane
(`.github/workflows/release-assets.yml`).

> **Implementation note (2026-09-13):** the desktop shell is Electrobun
> (Bun + CEF); see [ADR 0006](../decisions/0006-browser-lanes-and-desktop-shell.md).
> There is no signed auto-update lane in the shell yet: `desktop_update_check`
> / `desktop_update_status` compare the running version against the latest
> GitHub release, and `desktop_update_install` hands off to the releases page
> for a manual download. Release-lane work (signed artifacts, updater
> manifests) is tracked in #370.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## Release channel

Updates are published to this repository's GitHub Releases; there is no separate
update server. The shell polls

```
https://api.github.com/repos/adea-ai/adea/releases/latest
```

from the shell process (never the webview) and compares the release tag against
the running version, which comes from `apps/desktop/package.json` — the version
Release Please bumps — with an `ADEA_APP_VERSION` override for local runs. The
GitHub origins (`api.github.com`, `github.com`) are baselined exceptions in
`scripts/check-desktop-origins.mjs`: the only origins the app talks to besides
the cloud origin are the ones it updates from.

## Trust chain

- The shell performs a read-only, unauthenticated release lookup; it downloads
  and installs nothing. A malicious or stale feed can at worst misreport
  availability and open the releases page.
- Installation is the user dragging the downloaded build into `/Applications`
  (or running the DMG), so no update payload is ever executed from inside the
  app and there is no update signing key to protect yet. When the signed
  auto-update lane lands (#370), verification keys will be baked in at build
  time and the feed will carry signed manifests.
- macOS builds are signed locally with the machine's stable
  `adea-local-codesign` identity so keychain grants survive rebuilds; release
  builds are still unsigned upstream (#370).

## User-visible policy

- The version dialog reports the running version, phase, release notes, and the
  release page (`github_url`), and auto-checks when it opens.
- `desktop_update_install` opens the release page in the default browser after
  confirming the URL is http(s); it refuses anything else and installs nothing
  itself.
- Network failure produces the explicit `failed` phase with the error message;
  it is never reported as current.

## State machine

`checking → available | current | failed`. There are no download, install, or
restart phases while installation is manual; the phase set matches
`DesktopUpdate` in `apps/web/src/lib/desktop-update.ts`.

## Pinned by

- `apps/desktop/tests/shell-commands.test.ts`: available/current/failed
  comparisons against a stubbed release feed, the packaged version reporting,
  and the http(s)-only install handoff.
- `scripts/desktop-ipc-boundary.test.ts`: the `desktop_update_*` command
  surface and its grant.
- `scripts/desktop-origin-boundary.test.ts` and
  `scripts/desktop-boot-boundary.test.ts`: the baselined GitHub origins.
- `.github/workflows/release-assets.yml` and `scripts/release-notes.mjs`: the
  published notes are validated before the release is edited.
