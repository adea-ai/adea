# Unified Workspace Projects and Sidebar

- Status: Accepted (2026-10-05).
- Date: 2026-10-05
- Scope: the left contextual sidebar shared by the Dev, Chat and Virtual views,
  and the data it is built from: workspaces, projects, local repository
  bindings, worktrees, cross-workspace status, workspace memory, connections
  and project sharing.
- Supersedes: the Dev project **group** model in
  [`docs/specs/dev-runtime.md`](../specs/dev-runtime.md) ("Durable
  project/session authority"), the cloud **room** entity in
  [`docs/specs/workspace-events.md`](../specs/workspace-events.md), and the
  rail workspace switcher. Each spec is amended in the change that ships the
  behaviour, as the router in `AGENTS.md` requires.

## Context

Adea has two sidebars and two project models. Chat and Virtual list cloud
**rooms** with their channels (`WorkspaceSidebar`); Dev lists local **groups ›
projects › sessions** from the desktop project/session register
(`DevSidebarNavigation`). Workspaces are switched from a dropdown on the global
rail, and the transition is easy to miss even though the workspace is the
context and memory boundary that matters most.

Each view is an abstraction over the one below it (Dev › Chat › Virtual), so the
navigation should be one hierarchy rendered three ways rather than three
hierarchies. Three facts in the current code shape the design:

- The desktop Dev scope is a single device-local guest scope. The web client
  never binds it to the selected cloud workspace, so Dev projects are not
  workspace-isolated today. `desktop_identity_bind` requires runtime-node
  pairing and is the wrong tool for an everyday workspace switch.
- The primary checkout of a repository is a registration, not a worktree
  record, and production does not wire the worktree service, so a sidebar
  cannot list "the local checkout plus its worktrees" from runtime truth.
- "Needs your input" is not a session field. It is observed on the active
  harness run (`awaiting_input`, `awaiting_approval`).

## Decision

### One hierarchy: Workspace › Project › Leaf

The sidebar renders a single view-neutral tree built by a pure model in a new
`@adea-ai/workspace-nav` package that both `@adea-ai/dev-view` and
`@adea-ai/workspace-ui` consume:

- **Workspace** — the context boundary (name, logo, accent, Virtual world,
  memory, connections). Workspaces replace both the rail switcher and the Dev
  "group" layer. Only the active workspace is expanded and themed; the others
  are one row each with status chips, and clicking one switches.
- **Project** — one user-defined unit of work. A repository is optional.
- **Leaf** — `checkout` (the local primary checkout, labelled with the branch
  it actually has checked out), `worktree` (a temporary Adea worktree) or
  `task` (a cloud task with no worktree). A worktree linked to a task is one
  leaf. Sessions are panes in the main area, not sidebar rows.

Views supply an adapter for nouns, labels, icons and menus: Dev shows branch
names and the checkout row, Chat shows task titles, Virtual shows projects as
rooms and leaves as desks. The sidebar offers three groupings of the active
workspace: Project (default), Status (needs you, running, in review, idle) and
Recent (flat, most recent first). Conversations (direct and group) stay global.

### Projects are one cloud entity

Rooms are renamed to **projects** in the cloud schema, routes, events and
types, in one migration with a short maintenance window (owner decision; no
expand/contract shim). Project ids are stable and are the only identity the
desktop uses. `rooms.function_key` becomes `projects.icon_key`; the unused
`template_key`, `layout_ref` and `spatial_ref` columns are dropped; room
channels become project channels; tasks and agents reference `project_id`.
Virtual places projects in world slots by `sort_order`. The workspace `scene`
remains and is presented as the workspace's Virtual world.

### Local repository bindings, not local projects

The desktop register stops owning project names, order or groups. Its v2
authority record holds `ProjectBinding { projectId, repos, defaultBaseRef,
lifecycle }` keyed by the cloud project id, plus sessions and archive records.
`dev.group.*` and `dev.project.reorder` are removed; `dev.project.unbind`
removes a binding and never touches files. Existing v1 records are left unread
on disk (owner decision; no migration).

Landed as schema v2 of the register (see
[Dev Runtime](../specs/dev-runtime.md#durable-projectsession-authority-desktop-host)):
v2 partitions live in `authority-v2-<sha256(scope)>.sqlite3`, so no v1 file is
opened. `dev.project.create`/`import`/`clone` take the client-supplied cloud
`projectId`, and the Dev client projection is a flat list whose display names
the host supplies.

### Device workspace scope

A new trusted shell command selects the Dev scope for a cloud workspace the
user is a verified member of (guest temporary workspaces included). The scope
becomes `{ local accountId, cloud workspaceId, local runtimeNodeId }`, so each
cloud workspace gets its own register partition and switching workspaces
switches Dev projects with it. Verified memberships are cached with an expiry so
offline switching is limited to workspaces already verified.

Landed as `desktop_identity_select_workspace` (see
[desktop authentication](../specs/desktop-auth.md#device-workspace-scope)):
memberships are cached for 24 hours per credential digest, a paired cloud
binding takes precedence (selecting another workspace while bound is refused),
and the previous device-local guest partition is left on disk unread — never
deleted or migrated.

### The primary checkout is a worktree record

Registering a repository creates a `kind: 'primary'` worktree record whose
`headRef` comes from inspection. It cannot be archived, cleaned up or renamed,
and sessions bind to it like any worktree. Adea worktrees stay `kind: 'managed'`
and adopted ones `external`. Remote-only projects (a managed bare clone with
worktrees only) follow in a later change and have no primary record.

### Counts-only cross-workspace status

Collapsed workspaces and the "Needs you" strip read two counts-only sources:

- the cloud account summary (unread channels and mentions per member
  workspace, from one grouped query);
- the desktop `dev.summary.workspaces` operation, counting running and
  input-needing harness runs per workspace from the shared run registry for
  scopes with the same account and runtime node. It never opens another
  partition and returns no names, ids beyond the workspace id, or content.

### Memory, connections and sharing are workspace-owned

The detailed model is [ADR 0012](0012-workspace-memory-connections-sharing.md).

- **Memory** entries are private local content (ADR 0003): stored encrypted in
  the local content store keyed by workspace; the cloud holds `ContentRef`
  metadata only. A harness launch receives only the active workspace's memory.
- **Connections** bind vault-held credential references and plugin
  integrations to a workspace. The cloud stores ids only; secrets stay in the
  vault.
- **Sharing** adds project membership and invites inside a workspace;
  project-channel visibility follows membership.

## Privacy classification

| Field                                        | Classification     | Leaves the device                |
| -------------------------------------------- | ------------------ | -------------------------------- |
| Workspace name, logo, accent, world          | workspace metadata | yes                              |
| Project id, name, icon, order, `source_kind` | workspace metadata | yes                              |
| Repository root, remote, name                | workspace private  | no                               |
| Branch name, worktree title, diff counts     | workspace private  | no                               |
| Per-workspace running / needs-input counts   | workspace metadata | no (desktop only in this design) |
| Memory entry content                         | restricted local   | ciphertext replicas only         |
| Connection secret                            | credential         | never; reference ids only        |

## Consequences

- One sidebar component and one width preference serve all three views; the
  Chat/Virtual and Dev sidebar shells are deleted rather than adapted.
- Cloud rooms, Dev groups and the rail switcher are removed; their tests and
  snapshots are rewritten, not preserved.
- The rename needs a maintenance window, sequenced in
  [`docs/database-operations.md`](../database-operations.md) when it ships.
- The Dev contract changes (removed group operations, a new unbind, summary,
  worktree rename and diff summary operations) follow the operation registry
  rules in [`docs/specs/dev-runtime.md`](../specs/dev-runtime.md): spec,
  decoder, policy, audit classification and deny-by-default tests land together.
- Shared-chunk bytes move between the Chat, Virtual and Dev routes; their
  budgets in [ADR 0010](0010-performance-budgets-and-gates.md) are re-baselined
  in the change that moves them.

## Delivery

Stacked draft pull requests, each green on its own, in this order:

1. this decision;
2. workspace update with logo and accent;
3. rooms become projects;
4. the cloud account summary;
5. the device workspace scope;
6. group removal and local project bindings;
7. production worktrees and the primary checkout record;
8. the desktop cross-workspace summary;
9. the shared sidebar package and project tree;
10. the workspace accordion, inline create and rail switcher removal;
11. group-by modes and top-bar breadcrumbs;
12. workspace memory isolation;
13. workspace connections and branch switching;
14. project sharing;
15. remote-only projects.
