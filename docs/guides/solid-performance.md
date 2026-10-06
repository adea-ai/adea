# Solid performance conventions

How this codebase keeps the app feeling instant. These conventions exist
because the React→Solid migration left patterns that quietly work against
Solid's fine-grained reactivity. Follow them in new code; flag violations in
review the same way you would a type error.

## Lists keep their DOM across refetches

Server-backed lists (TanStack Query results and projections over them) produce
fresh object identities on every fetch. `<For>` keys rows by reference, so a
refetch remounts every row. Open menus close, focus and hover state drop, images
reload, and the whole subtree's DOM is rebuilt.

- Use `keyedRows` (`packages/workspace-ui/src/keyed-rows.ts`) for any list whose
  items arrive from the server: the transcript, thread replies, the project and
  channel sidebar, task board columns, the agent roster, plugin groups.
- Pass an `equals` comparator over the item's `version`/`updatedAt` stamps so
  unchanged rows skip downstream updates entirely. Every `*Summary` type carries
  these fields; do not invent deep-equality, compare the stamps.
- Read the row through `entry.item()` inside JSX expressions. Do not assign it
  to a local variable such as `const x = entry.item()`, because that snapshot
  will not update.
- `.map()` in JSX is for static, render-once data (menu items, column
  definitions). Anything that can change after mount belongs in `<For>`
  (identity-keyed), `<Index>` (position-stable primitives), or `keyedRows`.

## Effects are for DOM and browser APIs only

An effect that writes a signal which another computation could derive directly
is a React `useEffect` habit. It widens the reactive scope and adds a scheduling
step between the source and the reader.

- Derived values are plain accessor functions or `createMemo`, never
  `createEffect(() => setX(derive()))`.
- Values a lazy callback needs "eventually" are accessors, not mutable
  variables synchronized through an effect
  (`getWorkspaceId: () => activeWorkspace()?.id`, not a `let` plus a sync
  effect).
- One-time browser work goes in `onMount`, not a `createEffect` with no
  dependencies that happens to run once.
- Event listeners for the life of the component register once (`onMount` +
  `onCleanup`). An effect that re-runs per data change and re-registers
  listeners pays setup and teardown on every update. Keep the listener and let
  it call a closure that reads the latest signals.
- Async loads keyed on a reactive input are fine as effects; keep the
  `active`/`disposed` flag and `onCleanup` so stale completions cannot write.

## Code splitting is only real when the split is respected

`lazyComponent` starts its import on mount. An always-mounted lazy component
fetches its chunk at startup, so the code split exists only on paper.

- Gate optional surfaces behind `<Show when={...}>` so the chunk arrives with
  the intent (dialogs, settings overlays, secondary views).
- Warm the predicted path at module scope with `void import('<specifier>')`
  using the lazy boundary's specifier. The module map deduplicates the import,
  so the chunk downloads in parallel instead of waiting for another render
  cycle (see `workspace-entry.tsx`).
- Prefetch on intent: `onViewIntent` on rail buttons fires the target view's
  chunk on hover/focus so the click renders from cache. New lazy surfaces
  should offer an intent hook, not just an `onClick`.
- Route-level chunks should not statically import sibling lazy surfaces; keep
  the import graph shallow enough that one navigation does not fetch the whole
  app.

## Network work is budgeted per event, not per refetch

- The workspace event stream coalesces cache invalidations per chunk.
  `refresh()` in `packages/data/src/events.ts` deduplicates query keys before
  flushing. Do not add per-event invalidations elsewhere; queue them into the
  same path.
- Authoritative mutation responses update local state immediately (the message
  composer merges the created message into the transcript before the
  invalidation refetch lands). Waiting a round trip for confirmed data is
  visible latency, not correctness.
- Revisiting a channel restores the last-known transcript and scroll position
  while the refetch merges fresh pages. Keeping current content visible during
  refresh avoids showing a skeleton on every revisit.

## Cheap work stays cheap at scale

- `Intl.DateTimeFormat`, `URL`, and parser objects are constructed at module
  scope, not inside bindings that re-evaluate per row.
- Lookup maps (`Map` by id) over repeated `.find()` in render paths are
  `createMemo`s, not functions that rebuild the map on every read.
- Invariant service objects are hoisted out of accessors that rebuild on every
  reactive read; only the fields that actually change belong inside.

## Guardrails

- `scripts/react-artifacts-boundary.test.ts` fails the build if a `'use client'`
  directive or a React/Next import returns. The directive has no meaning in
  Solid/TanStack Start, so do not re-add it.
- `PERF.md` is the ledger: performance claims use the recorded method, and a
  change that does not beat the baseline beyond noise does not land.
