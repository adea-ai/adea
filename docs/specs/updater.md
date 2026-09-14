# Spec: desktop updater

How the desktop shell keeps itself current: a signed in-app update lane. This
page is the contract to read before touching `apps/desktop/shell/src/commands.ts`
(the `desktop_update_*` command family), `apps/desktop/shell/src/updater.ts`,
`scripts/sign-desktop-update.mjs`, or `.github/workflows/release-assets.yml`.

> **Implementation note (2026-09-13):** the desktop shell is Electrobun
> (Bun + CEF); see [ADR 0006](../decisions/0006-browser-lanes-and-desktop-shell.md).
> The shell downloads, verifies, and installs newer releases in place and
> relaunches. Apple code signing and notarization are still TODO(#370): the
> build is unsigned upstream and locally signed with the machine's
> `adea-local-codesign` identity.

**Changelog discipline:** a change to the behaviour described here lands in the
same commit as the update to this page (see `.github/CONTRIBUTING.md`).

## Release channel and feed

Updates are published to this repository's GitHub Releases. The release lane
attaches the disk image, the self-contained app archive
(`Adea-<tag>-macos-arm64.app.tar.zst`), and a signed `latest.json`:

```json
{
  "version": "0.25.0",
  "platform": "darwin",
  "arch": "arm64",
  "url": "https://github.com/adea-ai/adea/releases/download/v0.25.0/Adea-v0.25.0-macos-arm64.app.tar.zst",
  "sha256": "…",
  "signature": "…",
  "notes": "…",
  "publishedAt": "…",
  "runtime": { "sha256": "…" },
  "slim": { "url": "…-update.tar.zst", "sha256": "…", "signature": "…" }
}
```

### Slim updates

The lane also publishes `Adea-<tag>-macos-arm64-update.tar.zst`: the app layer
(client, shell code, preloads, resources) without `Contents/MacOS` and
`Contents/Frameworks` — no CEF framework, no Bun runtime, no launcher. The
manifest carries a `runtime.sha256` (the CEF framework, `MacOS/bun`, and
`MacOS/launcher` hashed together in that fixed order) and a second Ed25519
signature over `adea-desktop-update-slim/v<version>/<slim sha256>`.

When the installed bundle's runtime hash matches, the shell downloads and
verifies the slim archive (~1MB) and overlays it onto the existing bundle, so
no launcher reinstall runs; any mismatch — including a Bun, launcher, or CEF
bump — falls back to the full archive and full swap.

The shell polls `https://github.com/adea-ai/adea/releases/latest/download/latest.json`
from the shell process (never the webview). `version` is compared against the
running version, which comes from `apps/desktop/package.json` — the version
Release Please bumps — with an `ADEA_APP_VERSION` override for local runs.
Releases without a feed (forks, releases older than the lane) fall back to a
GitHub-API availability check plus a releases-page handoff.

## Trust chain

- `signature` is Ed25519 over `adea-desktop-update/v<version>/<sha256>` made
  with the private half in the `DESKTOP_UPDATE_SIGNING_KEY` repository secret
  (`scripts/sign-desktop-update.mjs` signs; the key never touches disk in the
  lane). The shell verifies with the public half baked into
  `apps/desktop/shell/src/updater.ts`.
- The archive must match the manifest's SHA-256 exactly and carry a valid
  signature before anything is extracted, and the extracted bundle must be a
  complete `Adea.app` (launcher + main-process entry) before anything is
  swapped. A hostile feed can at worst fail the install.
- The feed URL must be `https://github.com/adea-ai/adea/releases/download/…`;
  `ADEA_UPDATE_FEED`, `ADEA_UPDATE_ASSET_BASE`, and `ADEA_UPDATE_PUBLIC_KEY`
  re-point the channel for tests and staging — hash and signature checks are
  never skipped, so an override cannot install code we did not sign.
- `ADEA_UPDATE_SKIP_APPLY=1` stops short of the real bundle swap (tests).
- macOS builds are signed locally with the stable `adea-local-codesign`
  identity so keychain grants survive rebuilds; release builds remain unsigned
  upstream until notarization lands (#370).

## User-visible policy

- The version dialog reports the running version, phase, release notes, and
  the release page, and auto-checks when it opens.
- `desktop_update_install` requires `approved: true` and an `expectedVersion`
  matching the pending release, so a stale confirmation cannot install a
  different release. Installation downloads and verifies the archive, swaps
  the running `.app` (keeping no part of the old bundle), relaunches, and
  reports `installed` with `restart_required` while the swap script waits for
  the process to exit.
- If the running process is not a packaged bundle (a repo run), install hands
  off to the releases page instead of swapping.
- Network, checksum, and signature failures produce the explicit `failed`
  phase with the error message; they are never reported as current.

## State machine

`checking → available | current | failed`, then
`available → downloading → installing → installed | failed`. Progress reports
`downloaded_bytes`/`total_bytes` during the download; `installed` sets
`restart_required` and the app relaunches into the new bundle.

## Pinned by

- `scripts/desktop-update-boundary.test.ts`: manifest validation (platform,
  host, digest), Ed25519 signature verification and tampering (full and slim),
  the full check → download → verify → extract → staged-install flow against a
  local signed feed, slim-vs-full runtime-hash selection, install guards
  (approval, expected version), and the releases-page fallback.
- `apps/desktop/tests/shell-commands.test.ts`: feed availability phases and
  the packaged-version reporting.
- `scripts/desktop-ipc-boundary.test.ts`: the `desktop_update_*` command
  surface and its grant.
- `scripts/desktop-origin-boundary.test.ts` and
  `scripts/desktop-boot-boundary.test.ts`: the baselined GitHub origins.
- `.github/workflows/release-assets.yml` and `scripts/release-notes.mjs`: the
  published notes are validated before the release is edited.
