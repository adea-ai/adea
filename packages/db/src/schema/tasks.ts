import type { TaskSummary } from "@agent-hq/types";
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, text, unique, uuid } from "drizzle-orm/pg-core";

import { agents } from "./agents";
import { contentRefs } from "./content-refs";
import { entityId, timestampColumns } from "./conventions";
import { users } from "./identity";
import { rooms } from "./rooms";
import { appSchema } from "./schema";
import { workspaces } from "./workspaces";

export const taskLifecycleState = appSchema.enum("task_lifecycle_state", [
  "created",
  "queued",
  "in_progress",
  "in_review",
  "completed",
  "cancelled",
  "archived",
]);
export const taskPriority = appSchema.enum("task_priority", ["low", "normal", "high", "urgent"]);
export const taskKind = appSchema.enum("task_kind", ["bug", "feature", "chore"]);

export const tasks = appSchema.table(
  "tasks",
  {
    id: entityId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    creatorUserId: uuid("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    roomId: uuid("room_id").references(() => rooms.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    objective: text("objective"),
    objectiveContentRefId: uuid("objective_content_ref_id").references(() => contentRefs.id, {
      onDelete: "restrict",
    }),
    lifecycleState: taskLifecycleState("lifecycle_state").default("created").notNull(),
    kind: taskKind("kind").default("feature").notNull(),
    priority: taskPriority("priority").default("normal").notNull(),
    version: integer("version").default(1).notNull(),
    artifactRefs: text("artifact_refs")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    channelId: uuid("channel_id"),
    messageId: uuid("message_id"),
    threadRootMessageId: uuid("thread_root_message_id"),
    controlPlaneExecutionRef: text("control_plane_execution_ref"),
    controlPlaneWorkflowRef: text("control_plane_workflow_ref"),
    ...timestampColumns(),
  },
  (table) => [
    check("tasks_title_nonempty", sql`length(btrim(${table.title})) > 0`),
    check(
      "tasks_objective_available",
      sql`(${table.objective} is not null and length(btrim(${table.objective})) > 0 and ${table.objectiveContentRefId} is null) or (${table.objective} is null and ${table.objectiveContentRefId} is not null)`
    ),
    check("tasks_version_positive", sql`${table.version} > 0`),
    index("tasks_workspace_lifecycle_idx").on(
      table.workspaceId,
      table.lifecycleState,
      table.priority,
      table.createdAt
    ),
    index("tasks_workspace_agent_idx").on(table.workspaceId, table.agentId),
    index("tasks_workspace_room_idx").on(table.workspaceId, table.roomId),
    index("tasks_conversation_idx").on(table.workspaceId, table.channelId, table.messageId),
  ]
);

export const taskDependencies = appSchema.table(
  "task_dependencies",
  {
    id: entityId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    ...timestampColumns(),
  },
  (table) => [
    unique("task_dependencies_pair_unique").on(table.taskId, table.dependsOnTaskId),
    check("task_dependencies_not_self", sql`${table.taskId} <> ${table.dependsOnTaskId}`),
    index("task_dependencies_workspace_idx").on(table.workspaceId, table.taskId),
    index("task_dependents_workspace_idx").on(table.workspaceId, table.dependsOnTaskId),
  ]
);

export const taskMutations = appSchema.table(
  "task_mutations",
  {
    id: entityId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestId: uuid("request_id").notNull(),
    correlationId: text("correlation_id"),
    commandType: text("command_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    resultingVersion: integer("resulting_version"),
    resultSnapshot: jsonb("result_snapshot").$type<TaskSummary>(),
    ...timestampColumns(),
  },
  (table) => [
    unique("task_mutations_workspace_idempotency_unique").on(
      table.workspaceId,
      table.idempotencyKey
    ),
    check("task_mutations_idempotency_nonempty", sql`length(btrim(${table.idempotencyKey})) > 0`),
    check("task_mutations_command_nonempty", sql`length(btrim(${table.commandType})) > 0`),
    index("task_mutations_task_idx").on(table.workspaceId, table.taskId, table.createdAt),
    index("task_mutations_request_idx").on(table.requestId),
  ]
);
