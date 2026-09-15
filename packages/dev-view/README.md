# `@adea-ai/dev-view`

Shared SolidJS Dev View shell and platform-neutral layout/runtime seams.

The package owns only presentation, ephemeral selection, strict binary layout
operations, and versioned layout preferences. Privileged worktree, terminal,
file, Git, browser, device, agent, credential, and cleanup operations remain
behind the authenticated Dev Runtime contracts in `@adea-ai/types/dev-runtime`.
The default service is intentionally unavailable; it never fabricates runtime
data or treats the generic desktop invoke bridge as authorization.

Normative design and implementation constraints are in:

- [`../../docs/specs/dev-runtime.md`](../../docs/specs/dev-runtime.md)
- [`../../docs/specs/dev-runtime-operations.json`](../../docs/specs/dev-runtime-operations.json)
- [`../../docs/guides/dev-view-implementation.md`](../../docs/guides/dev-view-implementation.md)
- [`../../docs/research/dev-view-source-manifest.json`](../../docs/research/dev-view-source-manifest.json)
