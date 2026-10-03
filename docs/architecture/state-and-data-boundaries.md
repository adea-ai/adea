# State and Data Boundaries

- Status: Accepted (2026-09-23), from the M16 audit (#302).
- Date: 2026-09-23
- Scope: what owns state in the web app and the desktop surfaces, where the
  same fact was being kept twice, and the boundary that now enforces the
  browser-persistence discipline. The Dev Runtime's own client state lives in
  [`docs/specs/dev-runtime.md`](../specs/dev-runtime.md).

## Why this audit re-read the stack

#302 was written against Zustand, TanStack Query, and `nuqs`. All three answers
changed with the M6 migration: **Zustand and `nuqs` are gone** (no workspace
declares them), URL state is owned by TanStack Router search params, and server
state is TanStack Query inside `packages/data` (62 `useQuery` call sites across
web and workspace-ui). The audit therefore inventoried what exists rather than
what the title predicted.

## Ownership

| Fact                                                                                          | Owner                                     | Notes                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server state (workspaces, rooms, agents, tasks, artifacts)                                    | TanStack Query in `packages/data`         | Query keys are declared once (`workspaceQueryKeys`, `roomQueryKeys`, …); SSE events map to keys through `queryKeysForEvent` for invalidation                                                                                                                      |
| Realtime transport                                                                            | `packages/data/src/events.ts`             | One `createWorkspaceEventSubscription` (cursor, reconnect backoff, resync); the desktop shell does not open a second stream                                                                                                                                       |
| Ephemeral UI state (panels, collapsed groups, drafts, mobile drawer, Dev View pane selection) | `packages/state` workspace store          | Layout and presentation hints only; no server data is cached here. The Dev View project/session family lives here too, written only by Dev View itself as it resolves its selection (see the deep-linkable row)                                                   |
| Deep-linkable selection (`view`, `scene`, room/conversation/task in the URL)                  | TanStack Router search params             | Router-owned end to end (#616): a scene or Dev selection change is one guarded navigation, and no effect mirrors a selection fact into the store or out of it. The store's Dev View selection family is downstream of the router's request, never a second source |
| Browser persistence                                                                           | `packages/state/src/persisted-storage.ts` | The boundary this audit landed: one read/validate/quarantine discipline                                                                                                                                                                                           |
| Desktop-shell facts (window geometry, preferences, vault)                                     | Shell-side authorities                    | Web reaches them through the desktop bridge, never by reading shell storage                                                                                                                                                                                       |

## What was duplicated (and what happened to it)

Six storage keys lived in four modules with **three different disciplines**:

| Key                              | Was                                                                                                           | Now                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adea:rail-preferences:v1`       | parse → normalize → quarantine unknown shapes                                                                 | unchanged: the richest policy, kept as the reference for lossy normalization                                                                             |
| `adea:conventional-workspace:v2` | `JSON.parse` in try/catch, **`removeItem` on failure**, and anything that parsed went straight into the store | `readPersisted` + a shape validator; malformed text is quarantined, and a present-but-wrong-typed field rejects the blob instead of corrupting the store |
| `adea:plugin-catalog-global:v1`  | inline parse + shape + TTL check                                                                              | `readPersisted` with the same TTL rule extracted as one validator                                                                                        |
| `adea:plugin-catalog-cache:v1`   | the same inline parse/validate, duplicated                                                                    | shares that validator; its read-modify-write now goes through the boundary                                                                               |
| `adea:workspace-sidebar-width`   | bare `Number(...)` with an `isFinite` guard                                                                   | unchanged: a numeric key, already tolerant; named here so the boundary is not mistaken for "all storage must be JSON"                                    |
| URL hash for the settings dialog | router-owned, repaired in #601                                                                                | unchanged                                                                                                                                                |

The audit found a concrete hazard: `restoreConventionalState` merges its
argument into the store without validation. Before this change, a localStorage
blob such as `selectedRoomId: 42` or `drafts: "text"` could pass JSON parsing
but still contain the wrong field types, then be written into the workspace
store. The validator now rejects that input, and tests pin its rejection rules.

## Measured effect

- One failure policy instead of three: corruption is preserved for recovery
  (quarantine), staleness is dropped silently, unavailable storage is
  best-effort. Previously the conventional-workspace reader **deleted** the
  user's blob on a parse error.
- Two duplicated inline validators collapsed into one predicate
  (`isCatalogSnapshot`), which is what the TTL rule already was.
- No server-state duplication was found: nothing outside `packages/data`
  caches API responses, and no component calls `fetch` directly (the only
  `fetch` under `apps/web/src` is the Worker entry itself).

## Regression coverage

- `packages/state/tests/persisted-storage.test.ts`: the boundary's semantics:
  quarantine is byte-for-byte and non-destructive, a rejected shape is not
  quarantined, a throwing validator fails closed, and storage that throws on
  read/write degrades to "nothing persisted".
- `packages/workspace-ui/tests/unit/persistence-boundary.test.ts`: the
  conventional-workspace validator: full blob, legacy partial blob, and every
  wrong-typed field class that would previously have reached the store.

## Follow-ups

- ~~**Store/URL selection ownership.**~~ **Closed (#616).** `selectedScene`
  left the store (the virtual scene renders the router-derived prop), and the
  Dev View `devProject`/`devSession` mirror effects are gone: the URL request
  flows into Dev View through one prop, the resolved selection flows back
  through one callback that performs a single guarded navigation (written only
  when it actually differs — the #601 discipline). A test pins the exact
  fields the workspace store still holds
  (`packages/state/tests/index.test.ts`).
- **Rail preferences keep their own normalize+quarantine** because their
  normalization is lossy (it rebuilds the object and preserves the raw shape it
  could not map). If that stops being true, they fold into `readPersisted`.
