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

## Guarded manual release

Run the complete manual release from a clean, synchronized `main` checkout:

```sh
bun release
```

The command fetches `origin/main` and release tags, compares commits after the
latest GitHub Release, and exits successfully without running validation or
dispatching a workflow when no release-producing conventional commit exists
and the latest release already has a complete updater channel. If the tag
exists but its desktop assets or public updater manifest are incomplete, the
same command repairs that release instead of creating an unnecessary version.
Use `bun release --dry-run` to inspect the detected commits without
making remote changes.

When a release is needed, the command runs formatting, linting, type checks,
unit coverage, integration, build, native smoke, and browser E2E locally. It
then runs the pinned Release Please CLI locally, validates and rebase-merges the
generated version PR, and creates the tag and GitHub Release without depending
on a hosted Actions runner. Every remote merge is pinned to the inspected
release-PR head commit, and the GitHub token is obtained from authenticated
`gh` storage without printing it.

When a GitHub Release is published, `.github/workflows/release-assets.yml`
builds the Tauri desktop shell for macOS ARM64, Linux x64, and Windows x64. The
workflow aligns the checked-out desktop bundle version with the release tag,
uploads the bundles to the release, publishes the signed updater files to the
`agent-hq` R2 bucket served at `https://updates.adea.dev/desktop-updates/`
(requiring the `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets: R2 S3
credentials with Object Read & Write on that bucket), and verifies both the
release assets
and public manifest. GitHub Pages is intentionally not used: Pages does not
serve private repositories on the free plan.

With hosted Actions available, all three targets use GitHub-hosted native
runners and the Windows lane emits both MSI and NSIS installers. While
`CI_BILLING_PAUSED=true`, `bun release` temporarily starts two free self-hosted
runners on this Mac: a native macOS runner handles the macOS package, Windows
NSIS cross-compilation, and control jobs; an ephemeral amd64 Docker container
handles Linux. The runners stop after the release, so no Windows VM or
always-running Parallels instance is required. WiX MSI generation remains
native-Windows-only; the local fallback publishes the supported NSIS updater
package instead.

After the release assets and public updater manifest are verified, `bun release`
removes its disposable local state: runner registrations and files, isolated
Linux Buildx cache, release-runner images and volumes, the generated Tauri
target, and the local Turbo cache. A failed release only stops the runners and
retains those caches for a retry. Running `bun release` when the current GitHub
release is already complete also performs this cleanup, so stale release state
does not accumulate between releases. Development dependencies and application
database volumes are preserved.

Tauri updater packages are signed using repository secrets and the public
channel is rejected unless all three target entries contain signatures.
Platform-native code signing and notarization remain separate follow-ups:
macOS currently uses an ad-hoc identity and the local Windows fallback does not
Authenticode-sign its NSIS installer.

The mobile shells remain covered by the repository build and native smoke gate.
Android and iOS store distribution should be added as a separate release lane
once signing, provisioning, and store credentials are available; publishing
unsigned mobile output from the desktop release workflow would not be a usable
store release.
