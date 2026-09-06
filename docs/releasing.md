# Releasing Adea

Adea uses Code Foundry's direct workflow:

```text
feature branch -> pull request -> main -> Release Please pull request -> GitHub Release
```

Feature pull requests target `main` and use squash merges. The release workflow
opens a separate Release Please version pull request after changes reach
`main`; release pull requests use the configured rebase strategy. With no
private-repository automation token configured, that version PR is left for
manual readiness and merge. Feature PRs are likewise opened manually; the Code
Foundry draft-PR caller is intentionally disabled because this repository's
Actions policy does not permit the workflow token to create PRs.

Adea is versioned as one private, lockstep product. The root `CHANGELOG.md`
is therefore the only canonical release history; workspace package versions
are updated as extra files in the same Release Please change and do not carry
duplicate package-level changelogs.

## Release flow

Releases run entirely on GitHub-hosted runners; no self-hosted runner or local
orchestration is involved. When a Release Please version pull request is
merged, the tagged GitHub Release triggers
`.github/workflows/release-assets.yml`, which builds the Tauri desktop shell
for macOS ARM64, Linux x64, and Windows x64 on hosted `macos-14`,
`ubuntu-24.04`, and `windows-latest` runners, uploads the bundles to the
release, and verifies both the release assets and the updater channel.

The Tauri updater polls the release channel directly on GitHub:
`https://github.com/adea-ai/adea/releases/latest/download/latest.json`. The
`tauri-action` aggregates the matrix builds into that manifest, and the
verify-assets gate rejects the release unless every target is present,
signed, and pointing at this repository's release assets. The channel
follows the latest stable release automatically and ignores prereleases.

The Linux lane excludes the RPM bundle because Tauri 2.11's in-process RPM
bundler can hang indefinitely after rendering the desktop file; DEB + AppImage
provide the Linux install and updater artifacts we publish.

Tauri updater packages are signed using repository secrets and the public
channel is rejected unless all three target entries contain signatures.
Platform-native code signing and notarization remain separate follow-ups:
macOS currently uses an ad-hoc identity and the Windows NSIS installer is not
Authenticode-signed.

The mobile shells remain covered by the repository build gate. Android and iOS
store distribution should be added as a separate release lane once signing,
provisioning, and store credentials are available; publishing unsigned mobile
output from the desktop release workflow would not be a usable store release.
