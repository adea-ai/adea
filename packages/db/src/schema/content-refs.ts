import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { entityId, timestampColumns } from "./conventions";
import { appSchema } from "./schema";
import { workspaces } from "./workspaces";

export const contentType = appSchema.enum("content_type", [
  "message_body",
  "task_objective",
  "task_input",
  "private_field",
]);
export const contentSensitivity = appSchema.enum("content_sensitivity", [
  "sensitive",
  "restricted",
]);
export const contentStoragePolicy = appSchema.enum("content_storage_policy", ["local_authority"]);
export const contentSynchronizationPolicy = appSchema.enum("content_synchronization_policy", [
  "local_only",
  "e2e_optional",
]);
export const contentAvailability = appSchema.enum("content_availability", [
  "available",
  "offline",
  "missing",
  "deleted",
]);

export const contentRefs = appSchema.table(
  "content_refs",
  {
    id: entityId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id"),
    messageId: uuid("message_id"),
    contentType: contentType("content_type").notNull(),
    revision: integer("revision").default(1).notNull(),
    digestSha256: text("digest_sha256").notNull(),
    sensitivity: contentSensitivity("sensitivity").notNull(),
    storagePolicy: contentStoragePolicy("storage_policy").notNull(),
    synchronizationPolicy: contentSynchronizationPolicy("synchronization_policy").notNull(),
    availability: contentAvailability("availability").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    keyVersion: integer("key_version").notNull(),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    check("content_refs_revision_positive", sql`${table.revision} > 0`),
    check("content_refs_schema_version_positive", sql`${table.schemaVersion} > 0`),
    check("content_refs_key_version_positive", sql`${table.keyVersion} > 0`),
    check("content_refs_digest_sha256", sql`${table.digestSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "content_refs_association_consistent",
      sql`(${table.contentType} in ('task_objective', 'task_input') and ${table.messageId} is null) or (${table.contentType} = 'message_body' and ${table.taskId} is null) or ${table.contentType} = 'private_field'`
    ),
    check(
      "content_refs_deletion_consistent",
      sql`(${table.availability} = 'deleted' and ${table.deletedAt} is not null) or (${table.availability} <> 'deleted' and ${table.deletedAt} is null)`
    ),
    index("content_refs_workspace_availability_idx").on(
      table.workspaceId,
      table.availability,
      table.updatedAt
    ),
    index("content_refs_task_idx").on(table.workspaceId, table.taskId),
    index("content_refs_message_idx").on(table.workspaceId, table.messageId),
  ]
);
