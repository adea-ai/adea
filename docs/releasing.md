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
`.github/workflows/release-assets.yml`, which builds the bundled desktop client
and the Electrobun (Bun + CEF) shell in stable mode
(`electrobun build --env=stable`) on a hosted `macos-14` runner. A stable build
stages the distributables under `apps/desktop/shell/artifacts/`: a macOS disk
image (`*-Adea.dmg`) and the self-contained app archive
(`*-Adea.app.tar.zst`) whose payload carries the full bundle — the shell
binaries, the bundled CEF framework, and the packaged single-UI client. The
lane uploads both to the release, then verifies their structure. The lane can
also run without a tag via `workflow_dispatch`: pass an existing release tag to
package it, or leave the tag empty and set a ref to attach the artifacts to the
workflow run instead.

Only macOS ARM64 ships today; Windows and Linux desktop packaging has no
CI-verified installer story yet and stays out of the lane until it does. The
Electrobun shell is still unsigned, so Apple code signing and notarization
remain follow-ups. The signed auto-update lane _is_ wired: this lane generates
`latest.json` and publishes it beside the archives. The verify-assets gate
therefore rejects a release without a complete macOS bundle, and rejects one
whose bundle payload carries an updater manifest — the stable build's own
unsigned `*-update.json` included. That unsigned manifest is not the update
channel; `latest.json` is.

The mobile shells remain covered by the repository build gate. Android and iOS
store distribution should be added as a separate release lane once signing,
provisioning, and store credentials are available; publishing unsigned mobile
output from the desktop release workflow would not be a usable store release.
