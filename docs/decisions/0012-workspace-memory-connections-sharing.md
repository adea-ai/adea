# Workspace Memory, Connections and Project Sharing

- Status: Accepted (2026-10-05).
- Date: 2026-10-05
- Extends: [ADR 0011](0011-unified-workspace-projects.md), which makes the
  workspace the context boundary and names memory, connections and sharing as
  workspace-owned.
- Scope: what each of the three is, where it is stored, who may change it, and
  how an agent session consumes it. Each lands in its own change with the
  spec amendment the router in `AGENTS.md` requires.

## Context

A workspace exists so that context does not leak: what an agent remembers,
which accounts it acts as and who can see a project should follow the workspace
the user is in. Today none of the three has a backing system. Agent sessions
receive no Adea-managed memory, credentials are chosen per repository, and
every member of a workspace sees every project.

## Decision

### Memory: Adea-managed notes, per workspace

- A **memory entry** is a short plain-text note (at most 2,000 characters)
  owned by one workspace: `{ id, workspaceId, text, source, createdAt,
updatedAt, revision }`, where `source` is `user` or `agent`.
- Entry text is **restricted local content** under ADR 0003: it is stored
  encrypted in the desktop local content store with a new content type,
  `memory_entry`, whose associated data already binds the workspace id, so an
  entry cannot be replayed into another workspace. With `agent_hq_e2ee_sync`
  enabled, entries replicate as ciphertext through the existing content
  replica contract; the cloud never holds plaintext.
- **Injection.** When a harness session launches in a workspace, the launch
  transaction compiles that workspace's entries, newest first, into one bounded
  memory preamble (at most 16 KiB; overflow is reported, never silently
  truncated) and delivers it through the same ordered channel as the initial
  prompt (native or ACP, then harness API, then guarded PTY). A session never
  receives another workspace's memory. There is no account-wide memory.
- **Agent writes are proposals.** An agent may propose an entry through the
  harness channel; proposals are held as `pending` and become memory only when
  the user accepts them in Workspace settings › Memory. A rejected proposal is
  deleted.
- **Management.** Workspace settings lists, edits, deletes and accepts entries,
  and offers a per-workspace switch that turns injection off without deleting
  anything.

### Connections: git hosting credentials and harness accounts, per workspace

Amended by [ADR 0013](0013-control-plane-workspace-mapping.md): a workspace may
also hold cloud connections stored in the Control Plane credential vault for
cloud executions; device-local bindings below are unchanged.

- A **connection** binds a workspace to credential material the user already
  holds. Two kinds land first:
  - **Git hosting**: a Dev `CredentialRef` (GitHub or GitLab) used for clone,
    fetch, push and pull-request operations in that workspace's projects.
  - **Harness account**: a harness account profile, `{ id, harnessId, label,
credentialRefId }`, selecting which account or API key a harness uses
    when it launches in that workspace.
- Secrets stay in the existing credential vault; a binding stores ids only.
- Bindings are **device-local** and live in the workspace's Dev scope
  partition (ADR 0011's device workspace scope), because the credential
  references they name are device-local. A workspace with no binding for a
  kind falls back to the device default and the UI says so; it never silently
  borrows another workspace's binding.
- Project creation, worktree creation, pull-request actions and harness
  launch resolve credentials through the active workspace's bindings, and the
  resolved reference is recorded in the operation's audit record.

### Sharing: workspace members by role

- **Workspace invitations**: a member holding `membership.manage` invites a
  person by email with a role (`admin` or `member`). The invitation stores a
  digest of a single-use token, the email, the role and an expiry (7 days);
  accepting it creates the membership. Invitations are revocable, and no
  plaintext token is stored.
- **Project visibility**: each project is either `workspace` (every member,
  the default) or `members` (only its listed project members plus workspace
  owners and admins). Project members carry a role, `viewer` or `editor`.
- **Enforcement**: a `members` project, its channels, tasks and their events
  are readable only by those who can see the project. The checks run in the
  database query layer, as workspace membership checks do today, and the event
  stream filters per principal, so a hidden project never appears in another
  member's sidebar, search or event stream.
- **The Share action** on a project opens a dialog to change visibility, add or
  remove project members, change their role and invite new people into the
  workspace.

## Privacy classification

| Field                                        | Classification     | Leaves the device        |
| -------------------------------------------- | ------------------ | ------------------------ |
| Memory entry text                            | restricted local   | ciphertext replicas only |
| Memory entry id, revision, source, timestamp | workspace metadata | yes, with sync enabled   |
| Connection binding (credential ref ids)      | workspace private  | no                       |
| Credential secret                            | credential         | never                    |
| Invitation email and role                    | workspace metadata | yes                      |
| Invitation token                             | credential         | digest only, single use  |
| Project visibility and project member roles  | workspace metadata | yes                      |

## Consequences

- Each concern ships separately: memory (desktop store, launch injection,
  settings), connections (Dev scope bindings, credential resolution, settings)
  and sharing (cloud schema, query-layer checks, event filtering, the Share
  dialog).
- Event-stream filtering per principal is new: the stream currently treats
  every member as able to read every workspace event, and its spec
  ([workspace events](../specs/workspace-events.md)) changes with sharing.
- The local content store gains a content type, which its spec
  ([local content](../specs/local-content.md)) and the content-type union in
  `@adea-ai/types` record when memory lands.
