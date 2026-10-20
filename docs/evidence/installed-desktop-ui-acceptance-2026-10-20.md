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

| Command                                                                                  | Result                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                          | 823 packages, exit 0 (both the lane tree and the integration tree)                                                                              |
| `bun run --cwd apps/desktop shell:client:build`                                          | client built (local target, `http://localhost:3000`)                                                                                            |
| `bunx --bun electrobun build` (apps/desktop/shell)                                       | `dev-macos-arm64/Adea-dev.app` built — Electrobun 2.0.4, CEF and Bun 1.4.0 bundled                                                              |
| `bun run --cwd packages/db db:migrate`                                                   | 60 migrations applied and verified                                                                                                              |
| `bun run --cwd apps/web dev` (no provider endpoint configured)                           | local cloud on `http://localhost:3000`; server log contains no `neon`                                                                           |
| `bun scripts/installed-app-acceptance.ts --app-bundle … --artifact … --profile-parent …` | **21 passed, 1 failed, 22 rows** (row 6, §6.2) — the run predates the safety repair of §13, and the entry point was not executed again after it |
| `bun test tests/boot-credential-store.test.ts` (apps/desktop)                            | 7 pass, 0 fail, 15 assertions                                                                                                                   |
| `bun test scripts/installed-app-acceptance.test.ts`                                      | 11 pass, 0 fail, 22 assertions                                                                                                                  |
| `bun check -p shell/tsconfig.json` (apps/desktop)                                        | no type errors in 229 files                                                                                                                     |
| pre-commit hook (`vp run orch:typecheck`)                                                | 33/33 successful, no type errors in 324 files                                                                                                   |
| `bunx oxlint --deny-warnings` on the changed files                                       | exit 0                                                                                                                                          |

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

## 13. The safety repair (root-verified defects at `7ba2fba`)

Root personally verified concrete defects in the reviewed lane and asked for a
source repair. This section records what changed, what it is proven by, and
what is deliberately **not** yet proven.

### The defects and the repair

| Defect                                                                                                                                                               | Repair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The lane recursively removed an arbitrary caller-selected `--profile` root before creating it, and removed it again after writing the default artifact **inside** it | the run now creates a **uniquely named** directory (`mkdtemp`) inside a caller-named **parent** (`--profile-parent`). The parent is never removed and never written into outside the unique child. The unique child carries an ownership marker (`.adea-acceptance-owner`, a per-run token). The teardown removes it **only** when that marker still matches the run's token, and refuses a directory with no marker, with a foreign marker, or that is the parent itself. The default artifact path is now **outside** the directory the teardown removes, so a run's evidence outlives the run |
| Application-support cleanup inferred ownership from before/after entry names, so any directory that merely appeared during the run would be deleted                  | ownership is no longer inferred. Exactly **one** path is ever a candidate — the renderer's own profile directory for this application's identity **and** the channel the installed bundle was built for — and only when that exact path did not exist before the run. A path that existed before is never touched, a path outside the identity directory is never touched, and no other entry is ever read for cleanup. The artifact records the decision and states that no other entry was touched                                                                                             |
| `launchInstalledApp` passed `writeFileSync`'s `void` result to `writeSync`, and swallowed the log failure                                                            | the log now has an **explicit descriptor lifecycle**: `openSync` opens it, the tee writes to that descriptor, `close` closes it once, and a failed write is **counted** and reported in the artifact as `logWriteFailures` instead of being swallowed                                                                                                                                                                                                                                                                                                                                            |
| The "interrupted navigation" row could pass by observing the permanent Dev rail entry, which is present before and after any navigation                              | the row now compares the **rendered** view's signature with the signature the Dev view produced when it was opened on its own, and requires the settled view to match it and to differ from the interrupted view. The rail is no longer part of the observation. When the Dev and Chat renderings are indistinguishable, the row is `pending`, never a pass                                                                                                                                                                                                                                      |
| The "folder command" row passed when the command list was unavailable                                                                                                | the row passes only when the installed application's own command surface **exposes** the folder-pick command. When the list is not exposed, the row is `pending` with the reason recorded — invoking the pick would open the native panel, which needs a UI grant this run does not have, so it cannot be proved by calling it either                                                                                                                                                                                                                                                            |

A row that cannot be verified is now a first-class outcome: every row carries
a `status` of `pass`, `fail` or `pending`; `pending` is **never** a pass, and a
run with any pending or failed row is not green.

### The negative tests

`scripts/installed-app-acceptance.test.ts` grew from 11 cases to 23. The new
cases prove the properties root asked for, without touching the lane's
destructive path:

- a caller-named path that already holds data is left exactly as it was, and
  survives the teardown;
- two runs never share a directory;
- an unrelated directory with **no** ownership marker survives the teardown;
- a directory carrying another run's marker survives the teardown;
- the parent directory itself is never removed;
- the artifact of a run is outside the directory the teardown removes, and is
  still there afterwards;
- an application-support path that existed before the run is not removable,
  and a path outside the identity directory is not removable;
- the log's descriptor lifecycle writes the bytes, closes, and **counts** a
  write that arrives after the close;
- a `pending` row is never counted as a pass.

### What is proven, and what is deferred

**Proven on this head (safe, pure or local checks only):**
`bun test scripts/installed-app-acceptance.test.ts` → 23 pass, 0 fail, 55
assertions; `bun test apps/desktop/tests/boot-credential-store.test.ts` → 7
pass, 0 fail, 15 assertions; `bun check -p apps/desktop/shell/tsconfig.json` →
no type errors in 229 files; oxlint and oxfmt clean on all three changed
files.

**Deferred on purpose:** the lane's **entry point** and any check that
invokes its launch path were **not** executed after this repair, until root
reviews it. That means the repaired teardown, the repaired application-support
decision, the repaired log lifecycle and the two repaired UI rows are proven
by unit and static evidence only; the installed-application run of §4 remains
the run of the **pre-repair** code, and its row verdicts are those of that
run. The dynamic re-run is a bounded, reproducible next step:

```sh
bun scripts/installed-app-acceptance.ts \
  --app-bundle apps/desktop/shell/build/dev-macos-arm64/Adea-dev.app \
  --artifact <artifact>/installed-app-acceptance.json \
  --profile-parent <a directory this run may create children in>
```

with the expectation that the run creates a uniquely named child, writes the
artifact outside it, removes only that child, and leaves every other path on
the machine untouched.

## 14. The second safety repair — the real user profile is never written

Root reviewed the §13 repair and found a remaining hazard: the Application
Support path `dev.adea.desktop/<channel>` is **shared**. Its absence before a
run does not prove exclusive ownership — a real installation can create or
use it concurrently — and, more seriously, **launching the application writes
into the real user's profile even when nothing is deleted**. The §13 cleanup
fixed the deletion; it did not stop the write.

### What was measured about the native profile

- The Electrobun native core resolves the CEF profile root from the **real
  user home**: a disposable `HOME` does not move it (the earlier run's own log
  recorded `Using path: /Users/amf/Library/Application Support/dev.adea.desktop/dev/CEF`
  while `HOME` pointed at the disposable profile).
- The devkit exposes **no** per-run profile root: the only environment
  overrides are `ELECTROBUN_INSTALL_ROOT_NAME`, `ELECTROBUN_LAUNCHER_PID` and
  the Linux `XDG_*` variables. There is no supported route that moves the
  native profile out of the real user's Application Support directory.

**So supported isolation cannot be proved here.** The lane therefore does not
launch, and every row that needs the running application is `pending` with the
exact contract that is missing.

### The repair

| Concern                                                                        | Repair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A launch writes into the real user's Application Support directory             | `assessNativeProfileIsolation` decides, before anything is launched, whether the native profile root is provably **outside** the real user's Application Support directory. It is not, so `runInstalledAppAcceptance` returns **without launching** and records every launch-dependent row as `pending` with the missing contract named. The lane writes, marks and removes **nothing** under the real user's Application Support directory — not the profile, not a marker, not a deletion. The `applicationSupport` block of the artifact states `touchedByThisRun: false` |
| The shared path could be deleted on the strength of its absence before the run | the deletion path is **gone**. The lane removes exactly one thing: the unique directory it created and owns. `planApplicationSupportCleanup` survives as a pure, tested decision, but nothing acts on it, because acting on it was the hazard                                                                                                                                                                                                                                                                                                                                |
| An empty or failed socket discovery counted as a pass                          | `assessSocketObservation` returns `pending` when no peer was seen ("the traffic was not observed"), `fail` when a peer is off the loopback interface, and `pass` only when peers were observed and all are loopback                                                                                                                                                                                                                                                                                                                                                          |
| The no-provider proof only matched Neon by variable NAME                       | `inspectProviderEnvironment` makes **two independent observations**: the names of variables that mention a Neon identifier, and the names of variables whose **value** names a Neon host — a `DATABASE_URL` pointing at `*.neon.tech` is caught by the second check even though its name says nothing. Only names are reported; a value may carry a credential and the artifact is published                                                                                                                                                                                 |

### The new tests (37 cases, 101 assertions)

- a native profile inside the real root is **not** isolated, and the missing
  contract is named;
- a native profile outside it **is** isolated;
- the absence of the path before a run is shown not to be a licence to write
  there;
- a profile that appears **concurrently** (a real installation creating it
  while the lane runs) is never removed;
- the lane **does not launch** without a proved isolation route — the case
  injects a launcher that throws if called, and the lane never calls it;
- every launch-dependent and every UI row is `pending` in that case, and none
  of them is a pass;
- an empty socket discovery is `pending`; loopback peers are a pass; an
  off-loopback peer is a failure; a pending observation keeps the run red;
- the provider proof detects a Neon identifier and a Neon host **independently**,
  detects a Neon host in a `DATABASE_URL`, and never reports a secret value.

### What this means for the record

The installed-application run of §4 is the run of the **pre-repair** code, and
its row verdicts are that run's. After this repair the lane does not launch
without a proved isolation route, so the installed-application rows are
`pending` until one exists. **The exact missing contract is:**

> a supported per-run native profile root — an environment override or a
> supported per-run bundle identity that the Electrobun native core honours for
> its Application Support, CEF cache and log roots — so that launching the
> installed application writes nothing into the operator's own profile.

Until that contract exists, this lane asserts **no** installed-application
acceptance: it reports the static rows it can prove, and marks the rest
pending rather than claiming them. The bounded next test, once the contract
exists, is the same command as in §13 with `--profile-parent`, and the
expectation is that the run launches, writes only under the isolated root, and
removes only the unique directory it created.

## 15. The review repair — three evidence-correctness defects

Root's review of the §13/§14 repair (review `5588909120`, against the
published head `5ac039904`) found three remaining evidence-correctness
defects. The §14 safety decision is **unchanged**: the native renderer uses
the real Application Support directory, supported per-run isolation is still
unproved, so the lane does not launch and every dependent row stays pending.

### (1) The run's log failures were lost, and did not affect the verdict

Only the final launch's counter was read, and it was read before the
descriptor closed; the first launch's failures were discarded entirely.

- **One ledger for the whole run.** Every launch reports into it, and the
  ledger outlives every launch. A write that arrives **after** a descriptor
  closed is counted too — that failure used to be invisible.
- **One log file per launch** (`installed-app-<n>.log`). The second launch no
  longer truncates the first launch's evidence with a second `openSync(…,
'w')`.
- **A failure now decides a row.** `assessLogCompleteness` turns the
  aggregate count into the row `the-run-log-recorded-everything`: `pass` only
  when no write failed in any launch, and `fail` otherwise — so a run whose
  evidence could not be written is never green.

### (2) The interrupted-navigation row proved ordinary navigation

The row awaited the Chat view to settle before issuing the Dev request, so it
exercased a sequential navigation, not an interruption.

- The two requests are now dispatched in **one evaluation**, so the second is
  issued before the first can settle. `assessInterruptedNavigation` requires
  that overlap: without it the row is **pending**, never a pass.
- The row's claim is narrowed to what is observable — _two overlapping
  requests settle on the view the second request named_ — and the broad claim
  ("an interruption leaves no half-open intermediate view in the client's own
  state") is a **separate, pending row**, because the rendered view cannot
  show whether an intermediate request left state behind.

### (3) The folder-pick row accepted any command containing "folder" or "pick"

The row now requires the **exact** command identity the shell registers,
`desktop_folder_pick`. A surface that exposes `desktop_folder_pick_extra`,
`pick_folder`, `folder` or `pickDesktopFolder` does **not** prove the row —
those are failures, not passes. A surface that exposes no command list at all
is pending (calling the pick would open the native panel, which needs a UI
grant this run does not have), and a surface with no invoke at all fails.

### The focused negative tests

`scripts/installed-app-acceptance.test.ts` grew from 37 cases to **49
(130 assertions)**, all pure and synthetic:

- a write after the descriptor closed is counted in the run's ledger;
- the failures of two launches are counted **together**;
- the first launch's failure is not discarded when a second launch follows,
  and the second launch has its own log file;
- any failure makes the logging row a failure and the run red;
- overlapping requests that settle on the second destination pass, requests
  that were **not** overlapping cannot pass, overlapping requests that settle
  on the wrong view fail, and destinations that render the same content
  cannot be told apart;
- the exact folder-pick command proves the row; a command that merely
  contains "folder" or "pick" does not; an unexposed list is pending; a
  missing invoke surface fails.

### Still deferred

The lane's entry point and the installed-application run were **not** executed
after this repair. The §14 safety decision stands: without a supported per-run
native profile root, the lane does not launch, and the installed-application
rows stay pending rather than asserted.

## 16. The fail-closed repair — a label is not evidence, and the decision comes first

Root's review confirmed that the §14 repair addressed the immediate hazard by
**refusing execution** rather than by proving isolation, and that every
native-execution and profile-dependent row must stay pending. It found two
remaining weaknesses, both fixed here.

### (1) The isolation assessor was too permissive

The previous assessor accepted a _descriptive label_ (`isolationRoute:
'per-run-native-root'`) as proof, and accepted an outside path even with no
route at all. A label is not evidence: nothing checks it against anything the
native side honours.

- **Evidence, not labels.** The assessor now takes `IsolationEvidence` — the
  native profile root, the real user's Application Support root, and the
  contract the caller _claims_ — and resolves the claim against
  `SUPPORTED_ISOLATION_CONTRACTS`, a registry of contracts this repository
  recognises and can **validate**.
- **The registry is empty on purpose.** The Electrobun native core resolves
  the CEF profile root from the real user's home and the devkit exposes no
  per-run root, so no contract can be validated here. A claim naming any
  other identifier — including the old labels — is refused with the reason
  that a label, a bundle channel or a computed path is not evidence.
- **An outside path is not evidence by itself.** Without a validated
  supported contract the assessor fails closed even when the path is outside
  the real root.
- **No injected bypass.** `runInstalledAppAcceptance` takes the _evidence_
  and computes the decision itself; an injected decision is not accepted.

### (2) The decision came after the side effects

The entry point copied the bundle with `ditto` and registered it with
LaunchServices **before** it decided not to launch.

- **A side-effect-free preflight.** `runInstalledAppPreflight` answers one
  question — may this run launch? — by reading the bundle's own identity and
  nothing else. It performs **no** install, **no** registration, **no**
  launch and **no** real-user-profile access, and its artifact records
  `installed: false`, `registered: false`, `launched: false`.
- **The decision now comes first.** The entry point runs the preflight before
  it creates the disposable directory, copies the bundle or registers
  anything. When the proof is missing, the run writes the truthful pending
  evidence and stops.

### The focused tests

`scripts/installed-app-acceptance.test.ts` grew from 49 cases to **55 (155
assertions)**, all pure and synthetic:

- a descriptive label is refused, and the reason says a label is not
  evidence;
- an outside path with no validated route is refused as well;
- the supported-contract registry is empty, so nothing can be honoured yet;
- a supported contract that is not in force does not isolate the run;
- the preflight records **no** install, registration, launch or profile side
  effect, creates no install root, and reports `installed/registered/launched`
  as false;
- the preflight's rows are truthful: every launch-dependent row is pending,
  the isolation is reported as not isolated, and the run is not green;
- a claimed label does not make the preflight launch anything.

### The missing supported contract

> A **supported, validated** per-run native profile root: a contract the
> Electrobun native core honours for its Application Support, CEF-cache and
> log roots — for example an environment override it reads, or a per-run
> bundle identity it resolves — that this lane can check is in force, and that
> establishes a profile root outside the real user's Application Support
> directory.

Until such a contract exists and is registered in
`SUPPORTED_ISOLATION_CONTRACTS`, the lane refuses to install, register or
launch, and the installed-application rows stay pending. The §15 log,
navigation and exact-command repairs are unchanged.

## 17. The logging-order repair — the verdict is taken after the evidence is closed

Root's complete review at `1097e41fa` found one remaining concrete defect:
`ledger.count()` and `assessLogCompleteness` ran **before**
`running.stop()` closed the final descriptor and **before** the child's
stdout/stderr drained, so a final close failure and the trailing bytes the
process wrote could be omitted from a pass that the artifact then recorded.

### The repair

- **`stop()` is awaitable.** It now: signals the process, awaits the
  application's exit (bounded), awaits the drain of its stdout and stderr
  (bounded), and only then closes the log descriptor. The call resolves only
  when the descriptor is closed and the trailing output has been accounted
  for.
- **Every launch is kept and every launch is finalized.** The run collects
  each launch it starts; `finalizeAndAssessLaunches` awaits **every**
  launch's `stop()`, records a stop that _throws_ as a failure of the run's
  evidence, and **only then** snapshots the ledger and assesses the verdict.
  The artifact's `logWriteFailures` is that post-finalization snapshot, so a
  failure during the last close or the last trailing write can no longer be
  reported as a pass.
- The relaunch path awaits the first launch's stop before it starts the
  second one.

### The orchestration-level tests

The cases grew from 55 to **59 (168 assertions)**. They are not pure-helper
checks: they coordinate several launches through the same finalization the
run uses, with the **real** log machinery, and inject the failure at the
moment root described:

- a first launch whose stop emits trailing output, closes its descriptor, and
  then takes one more byte **after** the close — the failure is counted, the
  finalization reports `fail`, and the composed run verdict is red;
- a failure injected **after an await** inside the stop — a verdict taken
  before the stop resolved would have missed it;
- a stop that **throws** — recorded as a failure of the evidence;
- a clean finalization of two launches — a pass, and the row names both
  launches.

Every launch is asserted to have been finalized, in order, before the ledger
is read.

### Preserved

`c445` (no launch into the real user profile), `1097` (log aggregation across
launches, overlapping navigation, the exact folder-pick identity) and `674`
(the fail-closed validated isolation registry and the side-effect-free
preflight) are unchanged. The lane's entry point, the native launch path and
every real-profile operation remain unexecuted.

### The remaining native-isolation blocker

Unchanged and still the reason the installed-application rows are pending: no
**supported, validated** per-run native profile root exists. The Electrobun
native core resolves the CEF profile root from the real user's home, and the
devkit exposes no per-run Application Support root, so
`SUPPORTED_ISOLATION_CONTRACTS` is empty and the assessor fails closed. The
preflight therefore refuses to install, register or launch, and every row that
needs the running application stays pending.

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
