# Releasing Agent HQ

Agent HQ uses Code Foundry's direct workflow:

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

## Guarded manual release

Run the complete manual release from a clean, synchronized `main` checkout:

```sh
bun run release:manual
```

The command fetches `origin/main` and release tags, compares commits after the
latest GitHub Release, and exits successfully without running validation or
dispatching a workflow when no release-producing conventional commit exists.
Use `bun run release:manual --dry-run` to inspect the detected commits without
making remote changes.

When a release is needed, the command runs formatting, linting, type checks,
unit coverage, integration, build, native smoke, and browser E2E locally. It
then runs the pinned Release Please CLI locally, validates and rebase-merges the
generated version PR, and creates the tag and GitHub Release without depending
on a hosted Actions runner. Every remote merge is pinned to the inspected
release-PR head commit, and the GitHub token is obtained from authenticated
`gh` storage without printing it.

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
