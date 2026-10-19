# Fresh-install desktop app-flow — component-level acceptance

Base `3af8253666ac5f28d30b98333b56228e62907532` (`origin/main`, verified by a fresh
`git fetch origin main` before any work; the routing pin had not moved).
Predecessor publication: PR #1487 at `10690c2df7cd85b0d2518a7dfcefebbde8529957`.

Toolchain: Bun 1.4.3 and Node 24.21.0 (the versions `.mise.toml` pins). No Neon or
production database, no remote service, no external account, no native
Chrome/Chromium, no keychain prompt, and no app install or launch were used at
any point.

This lane is independent of PR #1493 (`test/desktop-app-flow-acceptance`, head
`e9fbc7053c20d78f1896d4995598af7ce386a706`). That branch, its worktree and its
files (`apps/web/src/lib/desktop-bridge.ts`,
`apps/web/test/desktop-app-flow.test.ts`) were not read for content, edited,
pushed, or transitioned.

## 1. What PR #1493 already established

Its published body records the exact suites that ran:

| Suite                                                                                                                    | Result                                              |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `bun test --conditions=browser --preload ../../scripts/test-solid-transform.ts test/desktop-app-flow.test.ts` (apps/web) | 12 passed, 0 failed (26 assertions)                 |
| the same command with the fix reverted                                                                                   | 11 passed, 1 failed on the missing-bridge case      |
| `bun run test` (apps/web)                                                                                                | 896 passed, 15 skipped, 0 failed                    |
| `tsc --ignoreConfig` on the new test file                                                                                | passed                                              |
| `code-foundry pre-commit`                                                                                                | 33/33 tasks successful; no type errors in 320 files |

It states, and this lane does not repeat, that App Library component wiring and
repeated/interrupted navigation are **not** qualified by those tests.

## 2. Existing chat / model / terminal coverage — not duplicated

| Area                             | Already covered by                                                                                                                                                                                                                                                            | This lane                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| chat                             | `packages/workspace-ui/tests/unit/lead-chat-model.test.ts`, `lead-model-request.test.ts`, `lead-model-state.test.ts`, `chat-composer-decision.test.ts`, `apps/web/test/desktop-chat-host.test.ts`, `desktop-first-run-chat.test.ts`, `packages/dev-view/tests/chat-*.test.ts` | no chat test added                                                                                    |
| model selection                  | `packages/workspace-ui/tests/unit/lead-model-request.test.ts`, `lead-model-state.test.ts`, `apps/web/test/model-selection-readiness.test.ts`                                                                                                                                  | no model-selection test added                                                                         |
| terminal                         | `packages/dev-view/tests/terminal-*.test.ts` (11 files), `packages/dev-view/tests/terminal-selection-preserver.test.ts`, `terminal-close.test.ts`, `apps/desktop/tests/dev-runtime-terminal*.test.ts`                                                                         | no terminal test added                                                                                |
| folder flow, shell side          | `apps/desktop/tests/shell-commands.test.ts` (`desktop_folder_pick`), `apps/desktop/tests/dev-runtime-roots.test.ts`, `project-registry.test.ts` (the `dev.project.authorizeRoot` boundary)                                                                                    | not repeated                                                                                          |
| folder flow, renderer side       | PR #1493 (`pickDesktopFolder`, `isDesktopRuntime`)                                                                                                                                                                                                                            | not repeated; this lane adds the **component** rules the helper does not own                          |
| App Library rail model           | `packages/workspace-ui/tests/unit/rail-preferences.test.ts`, `workspace-apps.test.ts`, `workspace-apps-opt-in.test.ts`                                                                                                                                                        | not repeated; this lane adds the **selection decisions** the rail model does not own                  |
| App Library navigation component | Chromium e2e only (`apps/web/e2e/appearance.spec.ts`, `workspace-navigation-presentation.spec.ts`, `workspace-menu.spec.ts`)                                                                                                                                                  | the decisions are now composed and pinned in a bun lane; the rendered component remains Chromium-only |

## 3. The four gaps, and where each one now lives

The picker rules and the App Library selection rules lived **inline in JSX
components** (`packages/dev-view/src/sidebar/add-project-form.tsx` and
`apps/web/src/components/workspace-navigation.tsx`). This repository's bun lane
has no DOM — no test in it renders a Solid component — so inline component logic
is unreachable there. The repository's own pattern for this is a model module
beside the component (`scan-preview-model.ts`, `dev-nav-model.ts`,
`github-import-model.ts`, `workspace-search.ts`), composed under `createRoot`
(`packages/dev-view/tests/appearance-cancel-reopen.test.ts`,
`apps/web/test/account-directory-identity-remount.test.ts`).

Two **behaviour-preserving extractions** therefore make the requested
composed-component scope reachable, and both are the enabling step for the
tests, not a behaviour change of their own:

1. `packages/dev-view/src/sidebar/project-folder-picker.ts` (new) — the picker's
   path, its pending flag and its request rules. `add-project-form.tsx` now
   reads the path and the pending flag from it and delegates the request to it.
   The only behavioural difference is the one the task asked for: a completion
   that arrives after the form was torn down no longer touches the disposed
   form (gaps 1 and 2). A test caught a second difference during development —
   the host must not be asked at all while a pick is in flight (gap 3) — and the
   model was corrected before it was wired.
2. `apps/web/src/lib/app-library-navigation.ts` (new) — the three App Library
   selection decisions. `workspace-navigation.tsx` now executes the decision
   instead of branching inline. The decisions are unchanged: a recorded change
   still moves to the destination that resolves, still never moves while the
   library is open, a request for a destination that is not in the rail still
   opens the library, and the recovery pass still rewrites a stale destination
   (gap 4).

### The four gaps

| Gap | Rule                                                            | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | a cancelled or failed pick leaves the typed path untouched      | `packages/dev-view/tests/project-folder-picker.test.ts` — "a cancelled pick leaves the typed path untouched", "a failed pick leaves the typed path untouched and never rejects", "a host without a picker changes nothing"                                                                                                                                                                                                                                                                                           |
| 2   | a late picker completion after navigation or unmount is ignored | the same file — "a completion that arrives after the form was torn down changes nothing" (the owner is disposed while the panel is open)                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | a repeated picker request asks the host once                    | the same file — "a repeated request while a pick is in flight asks the host once", "a request after a finished pick asks the host again"                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | App Library repeated and interrupted selection                  | `apps/web/test/app-library-navigation.test.ts` — "a repeated selection moves nowhere", "recording the same change twice is idempotent", "an interrupted selection does not dismiss the App Library", "an interrupted selection still leaves a reachable destination", "a request for a destination that is not in the rail opens the App Library", "a recorded change that hides the open destination moves to the one that resolves", "the recovery pass rewrites a destination that no longer matches the request" |

The OS boundary is mocked: the host is the `pickFolder` contract the Dev sidebar
and the detailed project dialog pass in, and the App Library record is a mocked
profile-local storage. No native panel, keychain, browser or account is
involved.

## 4. The coverage is meaningful — two mutations, each reverted

- Removing the disposed guard from the picker fails "a completion that arrives
  after the form was torn down changes nothing" (6 pass / 1 fail).
- Removing the interrupted-selection guard from the App Library decision fails
  "an interrupted selection does not dismiss the App Library" (6 pass / 1 fail).

The first version of the interrupted-selection case did **not** discriminate the
guard (it hid an app that was not the requested one, so both variants agreed).
The mutation exposed that, and the case was rewritten to hide the requested
destination — the real interrupted selection.

## 5. The blocked boundary — recorded, not passed

**Real installed-app execution is NOT qualified by this change.** It remains an
owned acceptance step, blocked on a safe environment and explicit approval. The
following were deliberately not performed and are therefore unproven:

- launching the packaged desktop app, and any installed-app flow inside it;
- the native folder picker's own panel, and the real OS folder selection behind
  `desktop_folder_pick`;
- the real macOS keychain (no prompt was raised, and no credential was read or
  written);
- a native Chrome/Chromium run, so every Chromium-only e2e flow — the rendered
  App Library component, the composed navigation wiring, and the real interaction
  of the picker button — stays unverified here;
- a real account, an external service, and any production or Neon database.

What is proven here is limited to the mocked-boundary bun lane: the composed
picker rules and the composed App Library selection decisions. The rendered
components and the installed app are not qualified, and this record does not
claim them.

## 6. Commands and results

| Command                                                                                                                                 | Result                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `bun test --conditions=browser --preload ../../scripts/test-solid-transform.ts tests/project-folder-picker.test.ts` (packages/dev-view) | 7 pass / 0 fail / 16 assertions                        |
| `bun test --conditions=browser --preload ../../scripts/test-solid-transform.ts test/app-library-navigation.test.ts` (apps/web)          | 7 pass / 0 fail / 14 assertions                        |
| the picker test with the disposed guard removed                                                                                         | 6 pass / 1 fail                                        |
| the App Library test with the interrupted-selection guard removed                                                                       | 6 pass / 1 fail                                        |
| `bun run test` (packages/dev-view)                                                                                                      | 1200 pass / 0 fail — 98 files                          |
| `bun run test` (apps/web)                                                                                                               | 891 pass / 15 skip / 0 fail — 118 files                |
| `bun run format:check` (repository root)                                                                                                | clean over 2830 files                                  |
| `bunx oxlint --deny-warnings` (repository root)                                                                                         | exit 0                                                 |
| `bun run typecheck` (repository root)                                                                                                   | no type errors in 321 files; `vp run` 33/33 successful |
| `tsc --ignoreConfig` over the two new test files                                                                                        | no errors (the package tsconfigs exclude `test/`)      |
| `git diff --check`                                                                                                                      | clean                                                  |

## 7. Ownership

No file owned by an active lane was touched: auth (#1478), Sim (#1485), the
packaged desktop bundle (#1486), the Postgres CI lane (#1483), the parser lane
(#1487), the R2 task-cache lane (#1488) and the app-flow lane (#1493) keep
their own files.
