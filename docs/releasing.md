# Releasing Agent HQ

Agent HQ uses Code Foundry's direct workflow:

```text
feature branch -> pull request -> main -> Release Please pull request -> GitHub Release
```

Feature pull requests target `main` and use squash merges. The release workflow
opens a separate Release Please version pull request after changes reach
`main`; release pull requests use the configured rebase strategy.

When a GitHub Release is published, `.github/workflows/release-assets.yml`
builds the Tauri desktop shell concurrently for macOS ARM64, Linux x64, and
Windows x64. The workflow aligns the checked-out desktop bundle version with
the release tag, caches each target independently, uploads the bundles to the
release, and verifies that all three target lanes produced assets.

Desktop signing is intentionally not enabled yet: no signing secrets are
committed or assumed, and macOS uses an unsigned identity. Add the repository's
Tauri signing secrets before treating these bundles as trusted updater assets.

The mobile shells remain covered by the repository build and native smoke gate.
Android and iOS store distribution should be added as a separate release lane
once signing, provisioning, and store credentials are available; publishing
unsigned mobile output from the desktop release workflow would not be a usable
store release.
