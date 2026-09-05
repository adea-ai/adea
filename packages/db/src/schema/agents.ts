import { sql } from "drizzle-orm";
import { check, index, jsonb, text, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "./schema";
import { entityId, timestampColumns, type JsonObject } from "./conventions";
import { rooms } from "./rooms";
import { workspaces } from "./workspaces";

export const agentLifecycleState = appSchema.enum("agent_lifecycle_state", [
  "active",
  "archived",
  "configuration_error",
]);
export const agentProfileState = appSchema.enum("agent_profile_state", [
  "available",
  "deprecated",
  "missing",
]);

export const agents = appSchema.table(
  "agents",
  {
    id: entityId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    roleSummary: text("role_summary"),
    avatarRef: text("avatar_ref"),
    characterRef: text("character_ref"),
    presentationMetadata: jsonb("presentation_metadata").$type<JsonObject>().default({}).notNull(),
    lifecycleState: agentLifecycleState("lifecycle_state").default("active").notNull(),
    profileId: text("profile_id").notNull(),
    profileVersion: text("profile_version").notNull(),
    profileState: agentProfileState("profile_state").default("available").notNull(),
    ...timestampColumns(),
  },
  (table) => [
    check("agents_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check("agents_profile_id_nonempty", sql`length(btrim(${table.profileId})) > 0`),
    check("agents_profile_version_nonempty", sql`length(btrim(${table.profileVersion})) > 0`),
    index("agents_workspace_lifecycle_idx").on(
      table.workspaceId,
      table.lifecycleState,
      table.name,
      table.id
    ),
    index("agents_workspace_room_idx").on(table.workspaceId, table.roomId),
    index("agents_profile_idx").on(table.profileId, table.profileVersion),
  ]
);
