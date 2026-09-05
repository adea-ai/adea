import { sql } from "drizzle-orm";
import { check, index, text, unique, uuid } from "drizzle-orm/pg-core";

import { appSchema } from "./schema";
import { entityId, softDeleteColumns, timestampColumns } from "./conventions";
import { users } from "./identity";

export const workspaceRole = appSchema.enum("workspace_role", ["owner", "admin", "member"]);

export const workspaces = appSchema.table(
  "workspaces",
  {
    id: entityId(),
    name: text("name").notNull(),
    scene: text("scene").default("home").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    ...timestampColumns(),
    ...softDeleteColumns(),
  },
  (table) => [
    unique("workspaces_owner_idempotency_unique").on(table.ownerUserId, table.idempotencyKey),
    check("workspaces_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check("workspaces_idempotency_nonempty", sql`length(btrim(${table.idempotencyKey})) > 0`),
    check("workspaces_scene_valid", sql`${table.scene} in ('home', 'work')`),
    index("workspaces_owner_idx").on(table.ownerUserId, table.deletedAt),
    index("workspaces_active_idx").on(table.deletedAt),
  ]
);

export const workspaceMemberships = appSchema.table(
  "workspace_memberships",
  {
    id: entityId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: workspaceRole("role").notNull(),
    ...timestampColumns(),
  },
  (table) => [
    unique("workspace_memberships_workspace_user_unique").on(table.workspaceId, table.userId),
    index("workspace_memberships_user_idx").on(table.userId, table.workspaceId),
    index("workspace_memberships_workspace_role_idx").on(table.workspaceId, table.role),
  ]
);

export const authorizationAuditRecords = appSchema.table(
  "authorization_audit_records",
  {
    id: entityId(),
    workspaceId: uuid("workspace_id").notNull(),
    principalKind: text("principal_kind").notNull(),
    principalId: text("principal_id").notNull(),
    permission: text("permission").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestampColumns().createdAt,
  },
  (table) => [
    check("authorization_audit_decision_valid", sql`${table.decision} in ('allowed', 'denied')`),
    index("authorization_audit_workspace_idx").on(table.workspaceId, table.createdAt),
    index("authorization_audit_principal_idx").on(table.principalKind, table.principalId),
  ]
);
