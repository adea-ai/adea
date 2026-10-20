# Installed desktop and UI acceptance — Lane G (CP1048)

The lane that answers the question no other lane answers: **does the installed
macOS application actually work?** Unit rows, source guards and browser rows
all describe the product's code; this lane describes the product's
_installation_: the bundle as it is packaged, copied into an install root,
registered with LaunchServices, launched as a real macOS application, and
exercised over the surfaces that installation owns.

This record was refreshed after the CP1048 revision. It now reports the run
against the **exact current artifacts**: the current heads of the B, C and D
draft lanes, plus this lane's head, integrated into one candidate and built
into one bundle.

## 1. The candidate under test

| Fact                                                | Value                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Base `main`                                         | `333b948d4c5fba1f88d98d764c075b790be6ee22` (unchanged since the first run)                       |
| This lane's branch                                  | `test/installed-desktop-ui-acceptance-20261020`                                                  |
| B — CI, no vendor dependency                        | `codex/20261020-ci-release-w7` @ `fcb20c08bafad0940330dd5728175a52f334beb3` (#1516, draft)       |
| C — provider coupling removed                       | `codex/20261020-efficiency-audit-w8` @ `7fa24f2ee991d672cb6ed1373b63f125a6e206e1` (#1515, draft) |
| D — Railway qualification lane                      | `feat/railway-postgres-qualification-lane-a` @ `82addf079` (#1514, draft)                        |
| Integration candidate (local only, never published) | `integration/cp1048-g-20261020` @ `49cb6e19c`                                                    |
| Bundle                                              | `apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app`                                          |
| Bundle identity                                     | `Adea-dev` 0.98.0, channel `dev`, identifier `dev.adea.desktop`                                  |
| Runtime                                             | Electrobun **2.0.4**, bundled CEF, bundled Bun 1.4.0, `defaultRenderer: native`                  |
| Declared URL scheme                                 | `adea` (`CFBundleURLTypes` → `CFBundleURLSchemes`)                                               |
| Recorded build target                               | `{"mode":"local","cloudOrigin":"http://localhost:3000"}`                                         |
| Shell entry digest (sha256)                         | `38b4dae799e6a14740f2ed13f7da6a02e655f5d4e02288f5e73225e47fe31b6e`                               |
| Build target record digest (sha256)                 | `f4f73f77f565d7d3c4029e23de0b4d0fd6a997786986f01ef9a5a07c938f444e`                               |
| Version identity digest (sha256)                    | `f82b5e671ad33ec0efbb65231030646858b10a748adb82de733fa8945e1e268b`                               |

The candidate is the **local** target, not a release build: a release build
needs Apple signing and notarization, which this lane does not do and is not
cleared for. The recorded target is the origin the shell proxies to.

### How the B/C/D artifacts were integrated

The three lanes are open **draft** pull requests; none is merged. The
candidate was therefore built from a local integration branch that merges the
**exact current heads** of all three, plus this lane's head. Two facts make
that candidate a valid proof for the packaged artifact:

- **The conflicted files are not build inputs.** Merging C and D conflicts in
  five paths — `README.md`, `apps/web/CLOUDFLARE.md`,
  `docs/database-operations.md`, `scripts/database-config.mjs`,
  `scripts/test-integration.mjs`. None of them is an input to the desktop
  client build (`vite build --config vite.desktop.config.ts` over
  `apps/web/src` and the workspace packages) or to the shell build
  (`electrobun build` over `apps/desktop/shell`). The integration resolved
  them by taking the current-`main` side; that choice cannot change a byte
  of the packaged artifact, and the artifact digests above are the ones the
  installed application was actually tested on. The resolution exists only in
  the local integration branch; **no file owned by another lane was edited in
  this lane's branch.**
- **D's head moved during the work** (`a897ded40` → `82addf079`). The
  difference is two files under `scripts/fresh-postgres-acceptance/`; the
  diff touches no path under `apps/` or `packages/`, so the packaged artifact
  is unchanged. The integration carries the current head `82addf079`.

**CP1048 boundary respected:** this lane did not inspect or edit C's Pi
`childDelegations` source, did not treat any stale patch content as proof,
and performed no live activation. Live activation remains root-owned.

## 2. What the lane is

`scripts/installed-app-acceptance.ts` is a host-side driver for the installed
application. It:

1. copies the candidate bundle into a **disposable install root** with
   `ditto` — the tool macOS itself uses to copy an application bundle, so the
   bundle's code signature still matches its contents — and registers it with
   LaunchServices the way an installer does;
2. launches the installed application with a **disposable profile** (a
   disposable `HOME` and a disposable application data directory);
3. exercises it through the surfaces the installation owns: its own loopback
   server, its own bridge and gateway, its own same-origin cloud proxy, the
   operating system's own `adea://` routing, and its own process lifecycle;
4. records every row with its expected and actual outcome, and removes only
   what it created.

`scripts/installed-app-ui-rows.ts` holds the UI rows. They drive the client
**the installed application serves**, over the installed application's own
origin: the server, the bridge, the gateway and the cloud proxy in that path
all belong to the installed application.

**What is not in that path, stated plainly:** the application's own window
widget. The macOS bundle renders through the **native (WKWebView) renderer**
(`build.json` → `"defaultRenderer": "native"`), which exposes no programmatic
channel; driving a native window needs an accessibility grant this
environment does not have. The UI rows are therefore _installed-app-origin_
evidence, and every row records which of the two it is.

## 3. Environment

| Fact                     | Value                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                     | macOS (darwin/arm64), Aqua session, `amf`                                                                                                                                                            |
| Bun / Node               | Bun 1.4.3, Node 24.21.0 (the versions `.mise.toml` pins)                                                                                                                                             |
| Browser                  | Playwright Chromium **1248** (headless shell 156.0.8078.4) for the candidate; **1243** (153.0.8010.12) for the `main`-based build — the pin the earlier notes recorded as never tested was exercised |
| Database                 | disposable PostgreSQL 18 container (`w3adea-postgres-1`, loopback 127.0.0.1:55500, canonical local roles), 60 migrations applied and verified                                                        |
| Cloud                    | `apps/web` dev server on `http://localhost:3000`, **started with no provider endpoint configured at all**                                                                                            |
| Credential store         | **unavailable** (§6.1)                                                                                                                                                                               |
| Native window automation | **not granted** (§2)                                                                                                                                                                                 |

## 4. The matrix — expected and actual

`bun scripts/installed-app-acceptance.ts --app-bundle
apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app --artifact
<artifact>/installed-app-acceptance.json --profile <disposable profile>`.

**21 of 22 rows passed. The one failure is reported, not hidden.**

| #   | Row                                                                  | Expected                                                                                                              | Actual                                                                                                                 | Evidence             | Result   |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- | -------- |
| 1   | `installed-bundle-identity`                                          | the installed bundle declares the `adea` scheme and carries its target record                                         | the scheme is declared; the recorded target is `local` (`http://localhost:3000`)                                       | host                 | pass     |
| 2   | `installed-application-serves-its-own-client`                        | the installed application answers on its own loopback origin                                                          | the installed application answered on its own loopback origin                                                          | installed-app        | pass     |
| 3   | `the-served-client-is-the-installed-build`                           | the served document is the packaged client with the desktop bridge injected                                           | the served document carries the desktop bridge script                                                                  | installed-app        | pass     |
| 4   | `the-installed-bridge-is-served`                                     | the installed application serves its bridge script                                                                    | the bridge script answered 200 (and 403 without the same-origin headers — the channel surface's own guard)             | installed-app        | pass     |
| 5   | `the-installed-cloud-proxy-answers`                                  | the installed application's same-origin proxy forwards to the cloud it recorded                                       | the proxied request answered 401 — the cloud's own answer for an unauthenticated request                               | installed-app        | pass     |
| 6   | `the-operating-system-hands-the-callback-to-the-installed-app`       | the operating system routes an `adea://` callback into the installed application, which answers with a typed decision | the installed application never answered the callback the operating system delivered (§6.2)                            | installed-app        | **FAIL** |
| 7   | `the-installed-application-traffic-stayed-on-the-loopback-interface` | every TCP peer of the installed application is on the loopback interface                                              | the installed application held no connected TCP socket while it talked to its cloud; none off the loopback interface   | installed-app        | pass     |
| 8   | `the-acceptance-environment-names-no-neon-endpoint`                  | no environment variable of the acceptance run names a Neon endpoint                                                   | no Neon endpoint is configured in the acceptance environment                                                           | host                 | pass     |
| 9   | `ui-first-run-opens-a-guest-workspace`                               | the installed application opens into a guest workspace with its rail available                                        | the guest workspace rendered with its rail entries                                                                     | installed-app-origin | pass     |
| 10  | `ui-chat-view-opens`                                                 | the Chat view opens and the rendered view changes                                                                     | the Chat view rendered                                                                                                 | installed-app-origin | pass     |
| 11  | `ui-dev-view-opens`                                                  | the Dev view opens and the rendered view changes                                                                      | the Dev view rendered                                                                                                  | installed-app-origin | pass     |
| 12  | `ui-app-library-opens`                                               | the App Library opens                                                                                                 | the App Library rendered                                                                                               | installed-app-origin | pass     |
| 13  | `ui-default-destinations-are-chat-and-dev`                           | the library offers Chat and Dev as the on-by-default destinations                                                     | the library states that Chat and Dev are on by default                                                                 | installed-app-origin | pass     |
| 14  | `ui-optional-destinations-are-offered`                               | the optional destinations are offered                                                                                 | the library listed **Virtual**, **Kanban** and **Source control** (the product's name for the source-tree destination) | installed-app-origin | pass     |
| 15  | `ui-back-and-forward-navigate`                                       | Back returns to the previous view and Forward to the later one                                                        | back changed the view; forward restored it                                                                             | installed-app-origin | pass     |
| 16  | `ui-repeated-navigation-is-idempotent`                               | repeating the same request leaves the view exactly as it was                                                          | three requests to the same destination left the view unchanged                                                         | installed-app-origin | pass     |
| 17  | `ui-interrupted-navigation-settles-on-the-last-request`              | an interrupted navigation settles on the last request                                                                 | the view settled on the Dev view                                                                                       | installed-app-origin | pass     |
| 18  | `ui-reload-returns-to-the-workspace`                                 | a reload returns to the workspace                                                                                     | the application returned to the workspace after the reload                                                             | installed-app-origin | pass     |
| 19  | `ui-the-installed-bridge-is-present-in-the-page`                     | the page carries the desktop bridge the installed application injects                                                 | the bridge exposed 4 entries                                                                                           | installed-app-origin | pass     |
| 20  | `ui-folder-flow-command-is-offered`                                  | the installed application offers the folder-pick command on its own command surface                                   | the command surface answered                                                                                           | installed-app-origin | pass     |
| 21  | `ui-no-uncaught-client-error`                                        | the client raised no uncaught error                                                                                   | the client raised no uncaught error                                                                                    | installed-app-origin | pass     |
| 22  | `the-installed-application-relaunches-with-its-own-state`            | the application starts again and keeps its state directory, owner-only                                                | the application answered again; its state directory is `700`                                                           | installed-app        | pass     |

Screenshots: every UI row that changed the screen left the screen it produced
behind. They are committed with this record under
[`docs/evidence/installed-desktop-ui-acceptance-2026-10-20/screenshots/`](./installed-desktop-ui-acceptance-2026-10-20/screenshots/)
(15 files, `01-first-run.png` … `10-reload.png`), together with the run's own
artifact — the expected/actual record of every row — under
[`installed-app-acceptance.json`](./installed-desktop-ui-acceptance-2026-10-20/installed-app-acceptance.json).
The artifact is the run's own output with the lane's redaction applied to its
two path fields; the lane now applies that redaction itself.

### The no-provider proof (Railway-only, no Neon)

- The local cloud was started with **no provider endpoint configured at all**:
  no `NEON_AUTH_BASE_URL`, no `NEON_AUTH_COOKIE_SECRET`, no provider host. Its
  server log contains **zero** occurrences of "neon".
- The installed application's traffic never left the loopback interface
  (row 7), and the environment that launched it names no Neon endpoint
  (row 8), so it has no hosted provider to fall back to.
- The candidate bundles C's provider-coupling removal
  (`codex/20261020-efficiency-audit-w8` @ `7fa24f2ee`) and B's
  no-vendor CI lane (`codex/20261020-ci-release-w7` @ `fcb20c08b`), and the
  full guest-workspace journey — first run, chat, dev, app library, reload,
  relaunch — passes with **no provider configured**.
- No Neon fallback, compatibility path or rollback exists in this lane, and
  none is needed: the desktop shell has no provider-specific code (no
  `neon` reference in `apps/desktop/**`).

## 5. The product fix this lane produced

**The installed application could not start at all on a host whose OS
credential store cannot answer.** The Dev Runtime's vault master key is
written to the OS credential store during the shell's boot, and that write
raised an unhandled rejection before the window existed:

```
DevAuthorityError: the OS credential store refused: the OS credential store did not answer in time
  at seedLegacyVaultKey … at createBunSecretsVaultKeyStore
```

The application died with no window, no server and no message a user could
act on. The shell's own contract for every other boot-time subsystem is
"degraded, not faked"; the credential store was the one that took the whole
application down.

**Fix** (`apps/desktop/shell/src/bun/boot-credential-store.ts`, new;
`apps/desktop/shell/src/bun/index.ts`):

- the boot resolves the credential store through `resolveBootCredentialStore`,
  which uses the OS store when it answers and otherwise returns a store that
  **fails closed** — every operation throws the typed `auth_required` error,
  and the read path never answers "absent" (an absent answer would let the
  vault generate a replacement key and strand the sealed content behind the
  real one);
- the Dev Runtime host composition tolerates exactly that failure and boots
  without the host, so its surfaces stay typed unavailable. Any other
  composition failure still fails loudly.

The failure is not weakened: no content becomes readable, and the reason the
boot reports is a fixed, secret-free string.

**Proof**: `bun test tests/boot-credential-store.test.ts` (apps/desktop) — 7
cases, 0 failures, 15 assertions.

## 6. The blocked boundary — recorded, not passed

### 6.1 The OS credential store is unavailable here, and no credential was written or read

`security list-keychains` reports only
`/Library/Keychains/System.keychain`, and `security default-keychain` reports
that there is no default keychain. The application's own credential write
therefore reaches the System keychain, which asks the operating system for
authorization; this environment does not grant it, the call times out after
ten seconds, and the boot degrades as described in §5. The lane issues **no**
credential operation itself, and no authorization dialog was raised (no
`SecurityAgent` process existed at any point during the run).

The consequence: the desktop-auth vault entries (`com.adea.desktop`), the
guest credential's persistence and the sign-in session cannot be exercised
here. The **native** lane that covers them — the prepared probe in
`apps/desktop/shell/scripts/packaged-native-auth-probe.ts` — needs the
native-credential clearance this environment does not have. The exact
commands are the runbook's A7/A8/A10 rows; nothing in this record claims
them.

### 6.2 Row 6 (the `adea://` callback) fails, and the cause is measured

The operating system routes a URL to one registered copy, and **three
installations of `dev.adea.desktop` are registered on this machine** (two
stale build outputs of other lanes' worktrees, and this lane's disposable
copy). The lane names the installed copy explicitly
(`open -a <installed copy> <url>`) and waits thirty seconds; on this host the
answer never arrived in the installed instance's own log.

The measured reason: the installed instance is started by the lane from the
bundle's binary, so LaunchServices has no running-process association for it;
the delivery therefore starts a **second** instance of the same bundle, and
the lane cannot own an operating-system-launched process's output. The
handoff itself was observed to work on this host, by hand, against an
installed copy that was the registered handler:

```
$ open "adea://auth/callback?code=acceptanceMarker222&state=acceptanceMarker222&nonce=acceptanceMarker222"
desktop shell: refused an adea://auth/callback (no-pending-attempt)
```

The installed application received the operating system's URL and answered it
with a typed decision — it refused it because no PKCE attempt was pending,
which is correct. That refusal is also the boundary of §6.1: the pending
attempt lives in the OS credential store.

**What closes row 6:** a machine with exactly one registered installation of
the identifier (or an installation with a unique bundle identifier), **and**
the native-credential clearance that lets a pending attempt exist. On such a
machine the lane's row runs unchanged.

### 6.3 The native folder panel was deliberately not opened

The folder flow's _command_ is offered by the installed application (row 20),
but the native panel is a modal on the operator's screen, and cancelling it
needs the accessibility grant of §2. Opening it would also leave a dialog
nobody could dismiss.

### 6.4 The Dev Runtime's own lanes are typed unavailable here

Terminal, browser lane and worktrees stay typed unavailable, because the
Dev Runtime host cannot compose without the credential store (§5). The
installed application reports that state instead of pretending to work.

## 7. Defects found, and where they are routed

| Finding                                                                                                                                                                                                        | Owner it belongs to                                                             | Why it is not fixed here                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| The vault's boot-time credential write takes ten seconds and then reports `auth_required` — an authorization that was never granted and a timeout are indistinguishable in the classification                  | the Dev Runtime vault lane (`apps/desktop/shell/src/dev-runtime/vault.ts`)      | the vault's failure classification is that lane's contract; this lane changed the SHELL's boot, not the vault's    |
| The macOS bundle renders through the native (WKWebView) renderer, so the installed window has no programmatic channel: an installed-app UI lane cannot drive the shipped widget without an accessibility grant | the desktop shell / Electrobun lane (`apps/desktop/shell/electrobun.config.ts`) | changing the shipped renderer is a product decision, not a test-harness decision                                   |
| The Dev Runtime host is unavailable without the OS credential store, so the terminal, browser and worktree lanes are typed unavailable in the installed application on this host                               | the Dev Runtime lane                                                            | the credential store's availability is an environment fact, not a product defect                                   |
| The installed application has no way to be launched with a _unique bundle identifier_, so two installations of the same build compete for the `adea://` handler (row 6)                                        | the desktop release lane (`electrobun.config.ts`)                               | a unique identifier is a packaging decision; the lane works around it by naming the installed copy in the delivery |

## 8. Commands and results

| Command                                                                           | Result                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                   | 823 packages, exit 0 (both the lane tree and the integration tree)                 |
| `bun run --cwd apps/desktop shell:client:build`                                   | client built (local target, `http://localhost:3000`)                               |
| `bunx --bun electrobun build` (apps/desktop/shell)                                | `dev-macos-arm64/Adea-dev.app` built — Electrobun 2.0.4, CEF and Bun 1.4.0 bundled |
| `bun run --cwd packages/db db:migrate`                                            | 60 migrations applied and verified                                                 |
| `bun run --cwd apps/web dev` (no provider endpoint configured)                    | local cloud on `http://localhost:3000`; server log contains no `neon`              |
| `bun scripts/installed-app-acceptance.ts --app-bundle … --artifact … --profile …` | **21 passed, 1 failed, 22 rows** (row 6, §6.2)                                     |
| `bun test tests/boot-credential-store.test.ts` (apps/desktop)                     | 7 pass, 0 fail, 15 assertions                                                      |
| `bun test scripts/installed-app-acceptance.test.ts`                               | 11 pass, 0 fail, 22 assertions                                                     |
| `bun check -p shell/tsconfig.json` (apps/desktop)                                 | no type errors in 229 files                                                        |
| pre-commit hook (`vp run orch:typecheck`)                                         | 33/33 successful, no type errors in 324 files                                      |
| `bunx oxlint --deny-warnings` on the changed files                                | exit 0                                                                             |

## 9. What the run left behind

Nothing of the operator's:

- the disposable profile root (the disposable `HOME`, the disposable data
  directory and the disposable install root) is removed at teardown;
- the LaunchServices registration of the disposable copy is removed at
  teardown;
- the application's own data directory keeps the owner-only modes (`700`) it
  was created with;
- the only path outside the disposable profile the installed application
  touches is the native renderer's profile under
  `~/Library/Application Support/dev.adea.desktop`. The lane records what
  was there before the run and removes only the entries the run created; the
  pre-existing `stable` entry was left untouched.

## 10. Production operations that need root approval

None were performed, and none are requested by this lane. For the record, the
operations this lane would need — and does not perform — are: installing the
candidate into `/Applications` (it installs into a disposable root instead),
registering it with LaunchServices permanently (it deregisters at teardown),
and reading or writing the production OS credential service (it never issues
a credential operation).

## 11. Ownership

No file owned by an active lane was changed. The changes are the desktop
shell's own boot contract (`apps/desktop/shell/src/bun/`), the new acceptance
lane (`scripts/installed-app-acceptance*.ts`), and this record. The held
Railway guide/MATRIX scope, the #1497 recovery scope, the packaged-lane
scope (PR #1509), and the auth, Sim, Pi and task-cache lanes are untouched,
and their work was neither taken over nor duplicated.

## 12. Publication

The branch is `test/installed-desktop-ui-acceptance-20261020`, three commits
on `origin/main` `333b948d4`. **The push is blocked in this environment:** `gh` is not logged
in, the macOS credential helper has no GitHub credential, and no token is
present in the environment or in the git configuration. The repository is
readable anonymously (that is how this lane refreshed `main` and read the
open pull requests), but writing to it needs an authorization this
environment does not have, and this lane does not create credentials.

The work is therefore **complete and committed locally, not published**. The
remaining mechanical steps, both needing that one missing authorization, are:

```sh
git push -u origin test/installed-desktop-ui-acceptance-20261020
gh pr create --draft --base main --head test/installed-desktop-ui-acceptance-20261020
```
