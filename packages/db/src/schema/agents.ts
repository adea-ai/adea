import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AgentProfileState } from '@adea-ai/types'
import { appSchema } from './schema'
import {
  controlPlaneIdentifierColumn,
  entityId,
  timestampColumns,
  type JsonObject,
} from './conventions'
import { projects } from './projects'
import { workspaces } from './workspaces'

export const agentLifecycleState = appSchema.enum('agent_lifecycle_state', [
  'active',
  'archived',
  'configuration_error',
])
/**
 * The stored catalog state of an Agent's pinned profile version.
 *
 * It records what the last authorized profile change observed. It is not a
 * read-time availability claim: `revoked`, `incompatible`, `unapproved` and
 * `unavailable` are derived by the authorized resolver when a profile is read
 * and are never persisted here. The stored vocabulary therefore stays a
 * subset of the read-time one, and the assertion below fails to compile if
 * the two ever drift apart.
 */
export const agentProfileState = appSchema.enum('agent_profile_state', [
  'available',
  'deprecated',
  'missing',
] as const satisfies readonly AgentProfileState[])

export const agents = appSchema.table(
  'agents',
  {
    id: entityId(),
    /**
     * The immutable public Control Plane Agent identity. It is minted once and
     * survives every profile version change, so an Agent keeps its identity
     * while its profile version evolves. Possessing it grants no authority.
     */
    controlPlaneAgentId: controlPlaneIdentifierColumn('control_plane_agent_id', 'agt'),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    isWorkspaceLead: boolean('is_workspace_lead').default(false).notNull(),
    name: text('name').notNull(),
    roleSummary: text('role_summary'),
    avatarRef: text('avatar_ref'),
    characterRef: text('character_ref'),
    presentationMetadata: jsonb('presentation_metadata').$type<JsonObject>().default({}).notNull(),
    lifecycleState: agentLifecycleState('lifecycle_state').default('active').notNull(),
    /**
     * The pinned profile reference. Together with `profileVersion` and
     * `profileRevision` it is the immutable selected profile version: a
     * submission is authorized against this exact triple and is refused when
     * the Agent's pin has moved, so an execution never follows a newer
     * version on its own.
     */
    profileId: text('profile_id').notNull(),
    /** The exact pinned profile version. Never a newer one. */
    profileVersion: text('profile_version').notNull(),
    /** The stored catalog state of the pinned version. */
    profileState: agentProfileState('profile_state').default('available').notNull(),
    /** The pin's own revision; it advances only with an authorized change. */
    profileRevision: integer('profile_revision').default(0).notNull(),
    /** Presentation and project-placement revision; profile pins keep `profileRevision`. */
    revision: integer('revision').default(0).notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique('agents_control_plane_id_unique').on(table.controlPlaneAgentId),
    unique('agents_workspace_id_unique').on(table.workspaceId, table.id),
    uniqueIndex('agents_workspace_lead_unique')
      .on(table.workspaceId)
      .where(sql`${table.isWorkspaceLead} = true`),
    check(
      'agents_workspace_lead_standalone',
      sql`${table.isWorkspaceLead} = false or (${table.projectId} is null and ${table.lifecycleState} <> 'archived')`
    ),
    check(
      'agents_control_plane_id_valid',
      sql`${table.controlPlaneAgentId} ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'`
    ),
    check('agents_name_nonempty', sql`length(btrim(${table.name})) > 0`),
    check('agents_profile_id_nonempty', sql`length(btrim(${table.profileId})) > 0`),
    check('agents_profile_version_nonempty', sql`length(btrim(${table.profileVersion})) > 0`),
    check('agents_profile_revision_nonnegative', sql`${table.profileRevision} >= 0`),
    check('agents_revision_nonnegative', sql`${table.revision} >= 0`),
    index('agents_workspace_lifecycle_idx').on(
      table.workspaceId,
      table.lifecycleState,
      table.name,
      table.id
    ),
    index('agents_workspace_project_idx').on(table.workspaceId, table.projectId),
    index('agents_profile_idx').on(table.profileId, table.profileVersion),
  ]
)
