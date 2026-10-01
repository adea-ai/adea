# `@adea-ai/dev-view`

Shared SolidJS Dev View shell and platform-neutral layout/runtime seams.

The package owns only presentation, ephemeral selection, strict binary layout
operations, and versioned layout preferences. Privileged worktree, terminal,
file, Git, browser, device, agent, credential, and cleanup operations remain
behind the authenticated Dev Runtime contracts in `@adea-ai/types/dev-runtime`.
The default service is intentionally unavailable; it never fabricates runtime
data or treats the generic desktop invoke bridge as authorization.

The sidebar's Add Project form loads on first open. Collapsing it afterward
keeps the form mounted, preserving its scan, confirmation, and group draft
without repeating the initial authorized-root/group requests.

The sidebar's shell, disclosures, navigation rows, status chips, and archive
presentation come from the published shared UI package. The Dev package keeps
runtime projections, selection, filtering, collapse preferences, and reorder
and archive callbacks. Selected projects and sessions use the shared active
section and row states; collapsing a project keeps its selection marker.
Deletion uses the shared confirmation dialog, preserving
trigger focus after either choice. Restoring a focused archive row returns focus
to the shelf toggle; failed reads retain their previous rows and show the error.
Missing archive timestamps are labeled unavailable. A provider without an authenticated runtime scope shows
an unavailable or empty projection instead of invented projects or sessions.

Normative design and implementation constraints are in:

- [`../../docs/specs/dev-runtime.md`](../../docs/specs/dev-runtime.md)
- [`../../docs/specs/dev-runtime-operations.json`](../../docs/specs/dev-runtime-operations.json)
- [`../../docs/guides/dev-view-implementation.md`](../../docs/guides/dev-view-implementation.md)
- [`../../docs/research/dev-view-source-manifest.json`](../../docs/research/dev-view-source-manifest.json)
