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
export const agentProfileState = appSchema.enum('agent_profile_state', [
  'available',
  'deprecated',
  'missing',
])

export const agents = appSchema.table(
  'agents',
  {
    id: entityId(),
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
    profileId: text('profile_id').notNull(),
    profileVersion: text('profile_version').notNull(),
    profileState: agentProfileState('profile_state').default('available').notNull(),
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
