# `@adea-ai/dev-view`

Shared SolidJS Dev View shell and platform-neutral layout/runtime seams.

The package owns only presentation, ephemeral selection, strict binary layout
operations, and versioned layout preferences. Privileged worktree, terminal,
file, Git, browser, device, agent, credential, and cleanup operations remain
behind the authenticated Dev Runtime contracts in `@adea-ai/types/dev-runtime`.
The default service is intentionally unavailable; it never fabricates runtime
data or treats the generic desktop invoke bridge as authorization.

The contextual sidebar is the shared `@adea-ai/workspace-nav` accordion (ADR
0011), mounted by `sidebar/dev-workspace-sidebar.tsx`: the host's cloud
projects joined by id with the register's local bindings, each bound project
listing its checkout and worktrees (`dev.worktree.list`) with observed harness
status and batched diff counts. The pure projection is `sidebar/dev-nav-model.ts`;
runtime reads live in `sidebar/dev-nav-runtime.ts`, and mutations and dialogs
load on first use (`sidebar/dev-nav-actions.ts`, `sidebar/dev-nav-dialogs.tsx`).
"New project" and "Add repository…" open the add surface, which loads its form
on first open and binds the cloud project id being added; the repository
registry sits behind Project settings. The archive shelf is the sidebar footer.
Archived-session deletion uses the shared confirmation dialog, preserving
trigger focus after either choice. Restoring a focused archive row returns focus
to the shelf toggle; failed reads retain their previous rows and show the error.
Missing archive timestamps are labeled unavailable. A provider without an authenticated runtime scope shows
an unavailable or empty projection instead of invented projects or sessions.

Normative design and implementation constraints are in:

- [`../../docs/specs/dev-runtime.md`](../../docs/specs/dev-runtime.md)
- [`../../docs/specs/dev-runtime-operations.json`](../../docs/specs/dev-runtime-operations.json)
- [`../../docs/guides/dev-view-implementation.md`](../../docs/guides/dev-view-implementation.md)
- [`../../docs/research/dev-view-source-manifest.json`](../../docs/research/dev-view-source-manifest.json)
