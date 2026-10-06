# @adea-ai/workspace-nav

The shared Workspace › Project › Leaf sidebar of
[ADR 0011](../../docs/decisions/0011-unified-workspace-projects.md). Both
`@adea-ai/dev-view` and `@adea-ai/workspace-ui` consume it, so it depends only
on `@adea-ai/ui`, `@adea-ai/app-ui`, `@adea-ai/types`, `solid-js` and
`lucide-solid`.

- `./model` is pure data with no Solid: the `NavTree` types, `mergeLeaves`
  (a worktree linked to a task is one leaf; status precedence needs you >
  running > in review > idle; checkout first), `projectSummary`,
  `workspaceChips` and `groupTree` for the Project, Status and Recent
  groupings.
- `./adapters` holds `createViewAdapter('dev' | 'chat' | 'virtual')`: nouns,
  labels, icons and row menus as data. The checkout menu never offers archive
  or delete; "Switch branch…" stays behind `branchSwitching`.
- `./breadcrumbs` holds `breadcrumbsFor(tree, selection, adapter)`: the top
  bar's Workspace › Project › Leaf path as data, with each earlier crumb's
  default-leaf target (absent when it would reopen what is shown).
  `@adea-ai/workspace-ui/workspace-breadcrumbs` renders it in the title slot.
- `WorkspaceNav` is presentational: all data and callbacks arrive through
  props. It composes the published `Tree`, sidebar-nav, dropdown-menu,
  `ActionButton`, `Input` and `Badge` primitives with the app's
  `WorkspaceIdentityMark`. Row hooks live in
  `@adea-ai/app-ui/workspace-nav.css`.

Chat and Virtual mount it through `@adea-ai/workspace-ui`'s
`WorkspaceNavSidebar` (the data projection is `workspace-nav-source.ts` there);
the Dev sidebar shell is replaced in a later change. The Workspaces heading's
group-by and "New workspace" actions are always visible. A host that controls
`creatingWorkspace` keeps the draft row open after Enter and can report
`workspaceDraftError` beside the kept name. The active workspace paints its
accent over its own subtree. Behaviour is covered by
`tests/unit` (model, adapters and breadcrumbs) and `apps/web/e2e/workspace-nav.spec.ts`
(fixture harness).
