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
and attempts the Electrobun (Bun + CEF) shell bundle for macOS ARM64, Linux x64,
and Windows x64 on hosted `macos-14`, `ubuntu-24.04`, and `windows-latest`
runners, uploads whatever artifacts the shell build produced, and verifies the
release assets.

The Electrobun shell is unsigned: signing, notarization, and the auto-update
lane are not wired yet (tracked in #370). The verify-assets gate therefore
rejects a release with no Adea desktop artifacts, and rejects any release that
publishes an updater manifest before that work lands. macOS and Windows
code-signing remain follow-ups in the same issue.

The mobile shells remain covered by the repository build gate. Android and iOS
store distribution should be added as a separate release lane once signing,
provisioning, and store credentials are available; publishing unsigned mobile
output from the desktop release workflow would not be a usable store release.
