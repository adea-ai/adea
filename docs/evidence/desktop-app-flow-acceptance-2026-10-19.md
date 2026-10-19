# Fresh-install desktop app-flow acceptance — mapping, one confirmed defect, and the blocked boundary

Base `79790737d427a4b7902e733dcfdef3306786370b` (`origin/main`, verified by a fresh
`git fetch origin main` before any work; the pin had not moved). Predecessor
publication: PR #1487 at `10690c2df7cd85b0d2518a7dfcefebbde8529957`, open, draft,
auto-merge off.

Toolchain: Bun 1.4.3 and Node 24.21.0 (the versions `.mise.toml` pins).
Dependencies: `postgres` 3.4.9, `drizzle-orm` 0.45.3 (unmodified). No Neon or
production database, no remote service, no external account, no native
Chrome/Chromium, no keychain prompt, and no app install were used at any point.

## 1. Mapped existing app-flow coverage

The four named areas, and where each one is covered today.

| Area                               | Covered by                                                                                                                                                                                                                                                                                                                                                                  | Gap                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Library preference persistence | `packages/workspace-ui/tests/unit/rail-preferences.test.ts` (defaults, ordering, hidden items, quarantine of a corrupt record, a blocked store, the storage round trip), `packages/workspace-ui/tests/unit/workspace-apps.test.ts` (enable/disable, reorder, opt-in, unknown contribution ids), `packages/workspace-ui/tests/unit/workspace-apps-opt-in.test.ts`            | The **fresh-install read** (no stored record at all, and no storage at all) and the **relaunch** (a new profile over the same persisted bytes) were not composed with the destination resolution. The component-level wiring is Chromium-only (`apps/web/e2e/appearance.spec.ts`, `apps/web/e2e/workspace-navigation-presentation.spec.ts`, `apps/web/e2e/workspace-menu.spec.ts`). |
| chat / model selection             | `packages/workspace-ui/tests/unit/lead-model-request.test.ts`, `lead-model-state.test.ts`, `apps/web/test/model-selection-readiness.test.ts`, `apps/web/test/desktop-chat-host.test.ts`, `apps/web/test/desktop-first-run-chat.test.ts`                                                                                                                                     | None found in the runnable lane. The App Library's own "the requested destination is unavailable" decision is inline in `apps/web/src/components/workspace-navigation.tsx` and is Chromium-only.                                                                                                                                                                                    |
| terminal / folder flows            | Terminal: `packages/dev-view/tests/terminal-*.test.ts` (11 files) and `apps/desktop/tests/dev-runtime-terminal*.test.ts`; the shell's native picker: `apps/desktop/tests/shell-commands.test.ts` (`desktop_folder_pick`); the authorization boundary after a pick: `apps/desktop/tests/dev-runtime-roots.test.ts`, `project-registry.test.ts`                               | The **renderer side of the folder flow** (`pickDesktopFolder` in `apps/web/src/lib/desktop-bridge.ts`) had **no** unit coverage anywhere: not in `apps/web/test/**`, not in `apps/web/e2e/**`, not in `apps/desktop/tests/**`. `isDesktopRuntime` was likewise uncovered.                                                                                                           |
| interrupted / repeated navigation  | `apps/web/test/desktop-chat-host.test.ts` (the chat lifecycle fence), `apps/web/test/desktop-first-run-chat.test.ts` (a deferred onboarding attachment that arrives after its scope was replaced), `apps/web/test/workspace-search.test.ts` (a late deep-link completion that must not overwrite a newer app switch), `packages/workspace-nav/tests/unit/stabilize.test.ts` | The App Library's own interrupted/repeated rules (the library must not dismiss itself while the user chooses; a repeated request is idempotent) are decided inline in `apps/web/src/components/workspace-navigation.tsx` and are only reachable through Chromium e2e. They were **not** re-specified here: no new model semantics were invented.                                    |

## 2. Confirmed defect: the folder picker rejected instead of failing closed

`apps/web/src/lib/desktop-bridge.ts` documents its own contract:

> Resolves null when the user cancelled, the command failed, or the running shell
> predates the command — the typed path input remains the fallback in every one of
> those cases.

`pickDesktopFolder` only honoured that contract when the shell bridge was
present. When the bridge was **not** installed, `invoke` threw synchronously
(the shell helper throws before it can return a promise), so the `.catch(() => null)`
was never attached and the picker **rejected** with
`Adea desktop shell bridge is unavailable` instead of resolving `null`.

Measured against the base with a mocked OS boundary:

```
no bridge installed at all: REJECTED -> Adea desktop shell bridge is unavailable
bridge present, folder picked: resolved "/Users/me/Developer/project"
bridge present, user cancelled: resolved null
bridge present, shell has no native picker: resolved null
bridge present, shell predates the command: resolved null
bridge present, empty path: resolved null
bridge present, multiple paths: resolved "/first"
```

The missing bridge is the fresh-install case: the shell injects
`window.__adeaDesktop` before the client boots, and until that injection lands
(or when it fails, and on the web lane where there is no shell at all) the picker
must fail closed to the typed-path fallback.

**Blast radius today:** the one in-repo consumer,
`packages/dev-view/src/sidebar/add-project-form.tsx`, already catches the
rejection (`await props.pickFolder().catch(() => undefined)`), so no user-visible
break was observed. The defect is a violation of the function's own documented
contract, and it leaves the failure mode to every present and future consumer
rather than to the one documented.

**Fix** (`apps/web/src/lib/desktop-bridge.ts`): make the call inside the promise
chain, so a shell that cannot answer — including a shell that is not there — is
the same `null` as a cancelled or failed pick. The change is behaviour-preserving
for every path that already worked.

**Proof the new coverage is meaningful:** with the fix reverted, the new test
`a missing shell bridge resolves null instead of rejecting` fails with
`Adea desktop shell bridge is unavailable`; with the fix it passes.

## 3. What this change adds

- `apps/web/src/lib/desktop-bridge.ts` — the one-line contract fix above.
- `apps/web/test/desktop-app-flow.test.ts` — new, with a mocked OS boundary
  (`window.__adeaDesktop`) and a mocked profile storage:
  - the folder flow: a picked folder, the shell's single-selection rule, a
    cancelled pick, a shell without a native picker, a shell that predates the
    command, an empty or non-string path, and a missing bridge;
  - the runtime detection that decides whether the desktop-only surfaces are
    offered at all;
  - the fresh-install App Library preference persistence: a profile with no
    record and no storage, the record across a relaunch, and a profile whose
    storage is denied.
- This file: the mapping and the boundary.

## 4. The blocked acceptance boundary — recorded, not passed

**Real installed-app execution is NOT qualified by this change.** It remains an
owned acceptance step, blocked on a safe environment and explicit approval. The
following were deliberately not performed and are therefore unproven:

- launching the packaged desktop app, and any installed-app flow inside it;
- the native folder picker's own panel, and the real OS folder-selection
  behaviour behind `desktop_folder_pick`;
- the real macOS keychain (no prompt was raised, and no credential was read or
  written);
- a native Chrome/Chromium run, so every Chromium-only e2e flow listed in
  section 1 — including the App Library component wiring and the interrupted and
  repeated navigation rules — is **unverified here**;
- a real account, an external service, and any production or Neon database.

What _is_ proven by this change is limited to the mocked-boundary unit lane
above. The installed-app acceptance step stays open and owned; this record
states the boundary, and does not claim it.

## 5. Commands and results

| Command                                                                                                                  | Result                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `git fetch origin main && git rev-parse origin/main`                                                                     | `79790737d427a4b7902e733dcfdef3306786370b` — matches the approved pin                       |
| `bun test --conditions=browser --preload ../../scripts/test-solid-transform.ts test/desktop-app-flow.test.ts` (apps/web) | 12 pass / 0 fail / 26 assertions                                                            |
| the same command with the fix reverted                                                                                   | 11 pass / 1 fail — `a missing shell bridge resolves null instead of rejecting`              |
| `bun run test` (apps/web, the whole unit lane)                                                                           | 896 pass / 15 skip / 0 fail — 911 tests across 118 files                                    |
| `bun run format:check` (repository root)                                                                                 | clean over 2823 files                                                                       |
| `bunx oxlint --deny-warnings` (repository root)                                                                          | exit 0                                                                                      |
| `bun run typecheck` (repository root)                                                                                    | no type errors in 320 files; `vp run` 33/33 successful                                      |
| `tsc --ignoreConfig` over `apps/web/test/desktop-app-flow.test.ts`                                                       | no errors in the test file (the web tsconfig excludes `test/`, so it is checked separately) |
| `git diff --check`                                                                                                       | clean                                                                                       |
| `code-foundry pre-commit` (the commit hook)                                                                              | runtime types generated, no type errors in 320 files, `vp run` 33/33 successful             |

## 6. Ownership

No file owned by an active lane was touched: auth (#1478), Sim (#1485), the
packaged desktop bundle (#1486), the Postgres CI lane (#1483), the parser lane
(#1487), and the R2 task-cache lane (#1488) keep their own files. The merged
parser branch and its worktree were not reused.
