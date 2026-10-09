import type {
  AccountAgentDirectoryPage,
  AccountDirectoryAgent,
  AccountDirectoryPageInput,
} from '@adea-ai/types/account-directory'
import type { UserPrincipalRef } from '@adea-ai/types'
import { sql } from 'drizzle-orm'

import {
  accountDirectoryPageLimit,
  decodeAccountDirectoryCursor,
  encodeAccountDirectoryCursor,
  isAccountResourceId,
} from './account-cursor'
import type { AgentHqDatabase, AgentHqTransaction } from './connection'
import { agents, projectMembers, projects, workspaceMemberships, workspaces } from './schema'

type Database = AgentHqDatabase | AgentHqTransaction

type DirectoryRow = {
  agentId: string
  workspaceId: string
  name: string
  roleSummary: string | null
  avatarRef: string | null
  projectId: string | null
  isWorkspaceLead: boolean
  lifecycleState: AccountDirectoryAgent['lifecycleState']
  profileId: string
  profileVersion: string
  profileState: AccountDirectoryAgent['profile']['state']
  profileRevision: number
  createdAt: Date | string
  updatedAt: Date | string
}

// The directory lists every workspace the principal belongs to in one query.
// The authorization checks stay distinct predicates, exactly as the
// workspace-scoped modules apply them:
//
// 1. workspace membership — the query starts from the principal's own
//    memberships joined to live workspaces, so a workspace they do not belong
//    to can never appear;
// 2. project access (ADR 0012) — an Agent attached to a `members` project the
//    principal is not listed on is invisible unless they own or administer
//    the workspace; its name never leaves the database.
//
// There is no private-participation predicate for Agents: an Agent is
// workspace metadata. Conversations add the third, participant check in
// `account-inbox.ts`.

const directorySelection = sql`
    agent.id as "agentId",
    agent.workspace_id as "workspaceId",
    agent.name as "name",
    agent.role_summary as "roleSummary",
    agent.avatar_ref as "avatarRef",
    agent.project_id as "projectId",
    agent.is_workspace_lead as "isWorkspaceLead",
    agent.lifecycle_state as "lifecycleState",
    agent.profile_id as "profileId",
    agent.profile_version as "profileVersion",
    agent.profile_state as "profileState",
    agent.profile_revision as "profileRevision",
    agent.created_at as "createdAt",
    agent.updated_at as "updatedAt"
  `

const directoryAuthorization = (userId: string) => sql`
    from ${workspaceMemberships} as membership
    inner join ${workspaces} as workspace
      on workspace.id = membership.workspace_id and workspace.deleted_at is null
    join ${agents} as agent
      on agent.workspace_id = membership.workspace_id
      and (
        agent.project_id is null
        or membership.role in ('owner', 'admin')
        or exists (
          select 1 from ${projects} as project
          where project.id = agent.project_id
            and project.visibility <> 'members'
        )
        or exists (
          select 1 from ${projectMembers} as project_member
          where project_member.project_id = agent.project_id
            and project_member.user_id = ${userId}
        )
      )
    where membership.user_id = ${userId}
  `

/**
 * Raw `execute` rows hand timestamps back as driver strings, not `Date`s;
 * normalize both shapes at the mapping boundary.
 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function directoryAgent(row: DirectoryRow): AccountDirectoryAgent {
  return Object.freeze({
    ...(row.avatarRef ? { avatarRef: row.avatarRef } : {}),
    createdAt: toIso(row.createdAt),
    id: row.agentId,
    isWorkspaceLead: Boolean(row.isWorkspaceLead),
    lifecycleState: row.lifecycleState,
    name: row.name,
    profile: Object.freeze({
      id: row.profileId,
      revision: Number(row.profileRevision),
      state: row.profileState,
      version: row.profileVersion,
    }),
    ...(row.roleSummary ? { roleSummary: row.roleSummary } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    updatedAt: toIso(row.updatedAt),
    workspaceId: row.workspaceId,
  })
}

/**
 * Authorized Agents across every workspace the principal belongs to,
 * independent of the currently selected workspace (M11.03). Same-name Agents
 * are distinct entries: the page order is `(workspace_id, name, id)` and the
 * cursor carries all three, so pagination steps through one total order over
 * stable identities. `includeArchived` widens the lifecycle filter the way
 * the workspace-scoped listing does, and `q` narrows by Agent name inside the
 * authorization — the directory's authoritative search, answered by the
 * database rather than by whatever pages a client happens to hold.
 */
export async function accountAgentDirectory(
  database: Database,
  principal: UserPrincipalRef,
  options: Readonly<AccountDirectoryPageInput> = {}
): Promise<AccountAgentDirectoryPage> {
  const limit = accountDirectoryPageLimit(options.limit)
  const after = options.after ? decodeAccountDirectoryCursor(options.after) : null
  const lifecycle = options.includeArchived ? sql`true` : sql`agent.lifecycle_state = 'active'`
  // The search predicate sits INSIDE the authorization statement: it filters
  // rows the caller may see, so a hidden project's Agent never matches, and it
  // is constant for the whole walk — the keyset cursor stays valid because
  // every page applies the same filter to the same total order over stable ids.
  const search = options.q ? sql`and position(lower(${options.q}) in lower(agent.name)) > 0` : sql``
  const cursor = after
    ? sql`and (agent.workspace_id, agent.name, agent.id) > (${after.workspaceId}::uuid, ${after.name}, ${after.id}::uuid)`
    : sql``
  const rows = await database.execute<DirectoryRow>(sql`
    select ${directorySelection}
    ${directoryAuthorization(principal.userId)}
    and ${lifecycle}
    ${search}
    ${cursor}
    order by agent.workspace_id asc, agent.name asc, agent.id asc
    limit ${limit + 1}
  `)
  const page = [...rows].slice(0, limit)
  const last = page.at(-1)
  return Object.freeze({
    agents: Object.freeze(page.map(directoryAgent)),
    ...(page.length < rows.length && last
      ? {
          nextCursor: encodeAccountDirectoryCursor({
            id: last.agentId,
            name: last.name,
            workspaceId: last.workspaceId,
          }),
        }
      : {}),
  })
}

/**
 * One directory Agent by stable id, for account-wide deep links. Archived and
 * `configuration_error` Agents resolve here by default — the lifecycle state
 * travels in the row so the caller can present it. Everything the caller
 * cannot see — no membership, hidden project, deleted workspace, or a missing
 * id — is the same `null`; denied is never distinguishable from nonexistent.
 */
export async function findAccountAgent(
  database: Database,
  principal: UserPrincipalRef,
  agentId: string,
  options: Readonly<{ includeArchived?: boolean }> = {}
): Promise<AccountDirectoryAgent | null> {
  if (!isAccountResourceId(agentId)) return null
  const lifecycle =
    options.includeArchived === false ? sql`agent.lifecycle_state = 'active'` : sql`true`
  const [row] = await database.execute<DirectoryRow>(sql`
    select ${directorySelection}
    ${directoryAuthorization(principal.userId)}
    and ${lifecycle}
    and agent.id = ${agentId}::uuid
    limit 1
  `)
  return row ? directoryAgent(row) : null
}
