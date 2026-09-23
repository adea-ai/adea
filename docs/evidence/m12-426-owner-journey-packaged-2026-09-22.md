# M12 #426/#541 packaged owner-journey evidence — 2026-09-22

Packaged owner-journey lane run for the #541 remainder on #426's first
completion box: "The owner journey passes against a packaged build with
recorded screenshots/video/log-free evidence and no manual database/file
repair." This record captures what the packaged lane proves today and records,
honestly, which journey legs stay blocked by the still-open packaged browser
engine (#537). It is evidence, not a closure claim.

## Build (release lane sequence)

Built on `feat/m12-426-cert` (worktree of main @ `f31adea7`, v0.45.1 + the
#472 real-OS acceptance + the #424 scale lane), macOS ARM64:

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@adea-ai/types
bunx turbo run build --filter=@adea-ai/web
bun run --cwd apps/desktop shell:client:build     # dist-desktop/client + injected cloud origin
bun build src/dev-runtime/terminal/sidecar/entry.ts \
  --outdir build/sidecar-dist --target=bun --minify   # (cwd: apps/desktop/shell)
bunx --bun electrobun build --env=stable              # (cwd: apps/desktop/shell)
```

The stable-channel build produces `apps/desktop/shell/build/stable-macos-arm64`
(`electrobun build complete`), whose `Adea.app` ships first as the Electrobun
launcher plus a compressed payload (`Contents/Resources/2ya9qxw07hig1.tar.zst`).
The launcher's documented first run self-extracts the payload in place
("Installing application files... Installation completed successfully."), after
which the bundle carries the expanded layout the packaged lane resolves:
`Contents/Resources/version.json` (`version 0.1.0`, `channel stable`) and
`Contents/Resources/app/` with the bundled Bun runtime, the SPA client, and
`dev-runtime-sidecar/entry.js`.

## Lane run

```sh
bun run test:packaged:owner-journey -- \
  --app-bundle apps/desktop/shell/build/stable-macos-arm64/Adea.app \
  --artifact artifacts/packaged/owner-journey-stable-2026-09-22.json
```

Exit code 2 = `PACKAGED-OWNER-JOURNEY BLOCKED` (the lane's typed result when a
row is blocked, distinct from failure). Machine-readable evidence: the JSON
artifact (schemaVersion 1, `manualRepair: "none"`). Steps:

| Step                      | Status  | Assertion recorded                                                                                                    |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `packaged-bundle`         | passed  | Adea 0.1.0 (stable) contains the bundled Bun and terminal sidecar; manifest, bun, and sidecar install labels resolve. |
| `project-import`          | passed  | `dev.project.import` bound one authorized root bookmark and group through the owner-approval verifier.                |
| `isolated-worktree`       | passed  | Worktree created from `main` on branch `feat/packaged-owner-journey`, lifecycle `ready`, bootstrap `not_started`.     |
| `runtime-session`         | passed  | `dev.session.create` returned a session in `preparing` on the isolated worktree.                                      |
| `archive-unarchive`       | passed  | `dev.session.archive` → `archived`, `dev.session.unarchive` → `restored`, generation-checked, 2 archive records.      |
| `browser-cdp`             | blocked | No CEF/CDP engine publishes frames in the packaged browser lane (#537).                                               |
| `owner-journey-recording` | blocked | Screenshot/video acceptance withheld until the packaged browser engine exists (#537).                                 |
| `disposable-cleanup`      | passed  | Temporary repository and data root removed; no manual file or database repair.                                        |

## What this proves and what stays open

Proven against the real packaged stable app's production authorities: owner
approval issuance/verification, root-bookmark minting, repository registration,
isolated worktree creation with bootstrap state, runtime session lifecycle, and
generation-fenced archive/unarchive with lossless restore — all on a disposable
fixture repository, cleaned up automatically.

Open and tracked, not waived:

- The browser/device leg of the owner journey and the screenshot/video
  recording acceptance remain blocked on #537 (no packaged CEF/CDP frames).
  The lane types these rows `blocked` rather than fabricating evidence.
- The stable bundle is ad-hoc signed on this lane; code signing/notarization
  evidence belongs to the release lane (`release-assets.yml` verify gates) and
  the offline/update matrix stays an open #426/#541 box.
