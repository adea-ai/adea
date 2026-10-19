# Fresh-install desktop app-flow — controller coverage, and the component boundary left open

Base `3af8253666ac5f28d30b98333b56228e62907532` at the time of the first
submission; the pull request now targets `main` at `b968e5d6d22d10cbe19fad9e0f7776359851f903`.
Predecessor publication: PR #1487 at `10690c2df7cd85b0d2518a7dfcefebbde8529957`.
Review repaired here: PR #1496, review `5577527842`.

Toolchain: Bun 1.4.3 and Node 24.21.0 (the versions `.mise.toml` pins). No Neon or
production database, no remote service, no external account, no native
Chrome/Chromium, no keychain prompt, and no app install or launch were used at
any point.

## 1. What this slice is, and what it is not

**This slice is controller/model coverage, with a source-level wiring guard. It
is NOT component acceptance, and that step stays OPEN.**

The rules that make the desktop app's folder flow and its App Library safe to
compose are now composed and pinned as controllers. The components that own
those interactions (`packages/dev-view/src/sidebar/add-project-form.tsx` and
`apps/web/src/components/workspace-navigation.tsx`) are bound to the controllers
by a wiring guard, so a component that stops delegating fails the lane.

**Component acceptance remains open** because this repository cannot mount these
components in the bun lane:

- no test in the repository mounts a Solid component under `bun test` — the
  bun lane has no DOM, and Solid's DOM renderer needs one;
- the only harness that does mount components
  (`apps/web/test/desktop-entry-auth-rotation.*`, plus
  `apps/web/test/native-session-inventory-*.tsx` and the fixture harnesses) is a
  **browser** harness, driven by Playwright
  (`apps/web/e2e/native-session-inventory-auth-rotation.spec.ts`) — a native
  browser run, which this lane may not perform;
- `apps/web/test/sim-offload-browser/acceptance.test.ts` is likewise a
  Playwright/Chromium acceptance test.

So an observable _navigation/history/field state_ through a mounted component is
not available here. The review's fallback applies, and this slice is labelled
accordingly: the controllers are covered, the wiring is guarded, and the mounted
component step is left open rather than claimed.

What closes the open step: a mounted-component run in the browser harness lane
(Playwright), or a DOM in the bun lane, exercising the real
`AddProjectForm` path field and the real `WorkspaceNavigation` destination
history with the mocked native boundary.

## 2. What PR #1493 already established

Its published body records the exact suites that ran, and this lane does not
repeat them:

| Suite                                                                                                                    | Result                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `bun test --conditions=browser --preload ../../scripts/test-solid-transform.ts test/desktop-app-flow.test.ts` (apps/web) | 12 passed, 0 failed (26 assertions)                           |
| the same command with the fix reverted                                                                                   | 11 passed, 1 failed on the missing-bridge case                |
| `bun run test` (apps/web)                                                                                                | 896 passed, 15 skipped, 0 failed — 911 cases across 118 files |
| `tsc --ignoreConfig` on the new test file                                                                                | passed                                                        |
| `code-foundry pre-commit`                                                                                                | 33/33 tasks successful; no type errors in 320 files           |

## 3. Existing chat / model / terminal coverage — not duplicated

| Area                       | Already covered by                                                                                                                                                                                                                                                            | This lane                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| chat                       | `packages/workspace-ui/tests/unit/lead-chat-model.test.ts`, `lead-model-request.test.ts`, `lead-model-state.test.ts`, `chat-composer-decision.test.ts`, `apps/web/test/desktop-chat-host.test.ts`, `desktop-first-run-chat.test.ts`, `packages/dev-view/tests/chat-*.test.ts` | no chat test added                                                                   |
| model selection            | `packages/workspace-ui/tests/unit/lead-model-request.test.ts`, `lead-model-state.test.ts`, `apps/web/test/model-selection-readiness.test.ts`                                                                                                                                  | no model-selection test added                                                        |
| terminal                   | `packages/dev-view/tests/terminal-*.test.ts` (11 files), `terminal-selection-preserver.test.ts`, `terminal-close.test.ts`, `apps/desktop/tests/dev-runtime-terminal*.test.ts`                                                                                                 | no terminal test added                                                               |
| folder flow, shell side    | `apps/desktop/tests/shell-commands.test.ts` (`desktop_folder_pick`), `apps/desktop/tests/dev-runtime-roots.test.ts`, `project-registry.test.ts` (the `dev.project.authorizeRoot` boundary)                                                                                    | not repeated                                                                         |
| folder flow, renderer side | PR #1493 (`pickDesktopFolder`, `isDesktopRuntime`)                                                                                                                                                                                                                            | not repeated; this lane adds the **controller** rules the helper does not own        |
| App Library rail model     | `packages/workspace-ui/tests/unit/rail-preferences.test.ts`, `workspace-apps.test.ts`, `workspace-apps-opt-in.test.ts`                                                                                                                                                        | not repeated; this lane adds the **selection decisions** the rail model does not own |

## 4. The four gaps, and where each one now lives

The picker rules and the App Library selection rules lived **inline in JSX
components**. Two model modules now carry them, beside the components that use
them, and the components execute the decision instead of branching inline:

1. `packages/dev-view/src/sidebar/project-folder-picker.ts` — the picker's path,
   its pending flag and its request rules.
2. `apps/web/src/lib/app-library-navigation.ts` — the three App Library
   selection decisions.

| Gap | Rule                                                            | Test                                                                                                                  |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | a cancelled or failed pick leaves the typed path untouched      | `packages/dev-view/tests/project-folder-picker.test.ts` — cancelled, failed, and a host that throws **synchronously** |
| 2   | a late picker completion after navigation or unmount is ignored | the same file — the owner is disposed while the panel is open                                                         |
| 3   | a repeated picker request asks the host once                    | the same file — one host call for three requests                                                                      |
| 4   | App Library repeated and interrupted selection                  | `apps/web/test/app-library-navigation.test.ts` — seven cases                                                          |

The OS boundary is mocked: the host is the `pickFolder` contract the Dev sidebar
and the detailed project dialog pass in, and the App Library record is a mocked
profile storage. No native panel, keychain, browser or account is involved.

### The wiring guard (the control a controller-only suite needs)

`scripts/desktop-app-flow-wiring.test.ts` reads the two component sources and
fails when a component stops delegating: the form must compose the picker
controller, delegate the request to it, read the path and the pending flag from
it, and must not call the host picker directly; the navigation must use the
three decisions and must not carry the inline branches they replaced. The
mutation control in the same file removes each delegation from a copy of the
real source and requires the guard to report it.

This is a source-level guard, in the repository's existing
`scripts/*-boundary.test.ts` idiom. It is **not** a mounted-component test and
does not claim to be one.

### The synchronous host failure (review item)

`choose()` invoked `options.pickFolder?.()` outside any catch, so a host that
throws **synchronously** rejected the request, while a host that rejects
asynchronously did not. The call is now inside the same protection as the
await: a synchronous throw is a failed pick — the request never rejects, the
typed path stays untouched, and the pending flag is cleared. The regression is
`a host that throws synchronously is a failed pick, not a rejection`.

## 5. The coverage is meaningful — five mutations, each reverted

| Mutation                                                             | Result                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| remove the disposed guard from the picker                            | fails "a completion that arrives after the form was torn down changes nothing" (7 pass / 1 fail) |
| remove the synchronous-throw protection from `choose()`              | fails "a host that throws synchronously is a failed pick, not a rejection" (7 pass / 1 fail)     |
| remove the interrupted-selection guard from the App Library decision | fails "an interrupted selection does not dismiss the App Library" (6 pass / 1 fail)              |
| remove the picker's delegation from the form (wiring mutation)       | the wiring guard reports it                                                                      |
| replace the navigation's recovery decision (wiring mutation)         | the wiring guard reports it                                                                      |

The first version of the interrupted-selection case did **not** discriminate the
guard (it hid an app that was not the requested one, so both variants agreed).
The mutation exposed that, and the case was rewritten to hide the requested
destination — the real interrupted selection.

## 6. The blocked boundary — recorded, not passed

**Real installed-app execution is NOT qualified by this change, and neither is
mounted-component acceptance.** Both remain owned acceptance steps, blocked on a
safe environment and explicit approval. The following were deliberately not
performed and are therefore unproven:

- launching the packaged desktop app, and any installed-app flow inside it;
- the native folder picker's own panel, and the real OS folder selection behind
  `desktop_folder_pick`;
- the real macOS keychain (no prompt was raised, and no credential was read or
  written);
- a native Chrome/Chromium run — so the **mounted** `AddProjectForm` and
  `WorkspaceNavigation`, their observable navigation/history/field state, and
  every Chromium-only e2e flow stay unverified here;
- a real account, an external service, and any production or Neon database.

What is proven here is limited to the controller lane plus the wiring guard.
The mounted components and the installed app are not qualified, and this record
does not claim them.

## 7. Exact receipts, and the 891 / 896 reconciliation

Both pull requests add one test file to the same base. The base is identical at
both heads — measured, not inferred:

| Tree                                           | apps/web cases | pass | skip | fail | files |
| ---------------------------------------------- | -------------- | ---- | ---- | ---- | ----- |
| base `79790737` (PR #1493's base)              | 899            | 884  | 15   | 0    | 117   |
| base `3af825366` (this PR's base)              | 899            | 884  | 15   | 0    | 117   |
| PR #1493 head `e9fbc7053` (+ its 12-case file) | 911            | 896  | 15   | 0    | 118   |
| this PR head (b0b0aedee, + its 7-case file)    | 906            | 891  | 15   | 0    | 118   |

The two bases carry the **same** case inventory: a JUnit run of both bases
produced 899 test cases each, with no case present at one base and absent at
the other, and no file with a differing case count.

**The reconciliation: 896 and 891 are both correct, for different heads.** 896
is PR #1493's pass count (911 cases − 15 skipped) at _its_ head, where its test
file contributes 12 cases. 891 is this PR's pass count (906 cases − 15 skipped)
at _this_ head, where its file contributes 7 cases. The earlier pull request
body carried #1493's 896 to this pull request, where it does not hold. The
correct figure for this head is **891 passed, 15 skipped, 0 failed — 906 cases
across 118 files**.

## 8. Commands and results

| Command                                                                                                                                 | Result                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `bun test --conditions=browser --preload ../../scripts/test-solid-transform.ts tests/project-folder-picker.test.ts` (packages/dev-view) | 8 pass / 0 fail / 18 assertions                          |
| `bun test --conditions=browser --preload ../../scripts/test-solid-transform.ts test/app-library-navigation.test.ts` (apps/web)          | 7 pass / 0 fail / 14 assertions                          |
| `bun test scripts/desktop-app-flow-wiring.test.ts` (repository root)                                                                    | 3 pass / 0 fail / 9 assertions                           |
| `bun run test` (packages/dev-view)                                                                                                      | 1201 pass / 0 fail — 98 files                            |
| `bun run test` (apps/web)                                                                                                               | 891 pass / 15 skip / 0 fail — 906 cases across 118 files |
| `bun run format:check` (repository root)                                                                                                | clean                                                    |
| `bunx oxlint --deny-warnings` (repository root)                                                                                         | exit 0                                                   |
| `bun run typecheck` (repository root)                                                                                                   | no type errors; `vp run` 33/33 successful                |
| `tsc --ignoreConfig` over the new test files                                                                                            | no errors (the package tsconfigs exclude `test/`)        |
| `git diff --check`                                                                                                                      | clean                                                    |
| `code-foundry pre-commit`                                                                                                               | runtime types generated; `vp run` 33/33 successful       |

## 9. Ownership

No file owned by an active lane was touched: auth (#1478), Sim (#1485), the
packaged desktop bundle (#1486), the Postgres CI lane (#1483), the parser lane
(#1487), the R2 task-cache lane (#1488) and the app-flow lane (#1493) keep
their own files. PR #1493 was not edited, pushed, transitioned or merged.
