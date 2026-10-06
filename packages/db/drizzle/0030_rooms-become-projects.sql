-- Rooms become projects (ADR 0011). A one-shot rename applied in a short
-- maintenance window: every statement renames in place so ids, rows, foreign
-- keys and channel history are preserved. See docs/database-operations.md.
ALTER TYPE "app"."room_lifecycle_state" RENAME TO "project_lifecycle_state";--> statement-breakpoint
ALTER TYPE "app"."channel_kind" RENAME VALUE 'room' TO 'project';--> statement-breakpoint
-- Historical events keep the 'room' aggregate; new events use 'project'.
ALTER TYPE "app"."workspace_event_aggregate_type" ADD VALUE IF NOT EXISTS 'project';--> statement-breakpoint
ALTER TABLE "app"."rooms" RENAME TO "projects";--> statement-breakpoint
ALTER TABLE "app"."projects" RENAME CONSTRAINT "rooms_pkey" TO "projects_pkey";--> statement-breakpoint
ALTER TABLE "app"."projects" RENAME COLUMN "function_key" TO "icon_key";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "template_key";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "layout_ref";--> statement-breakpoint
ALTER TABLE "app"."projects" DROP COLUMN "spatial_ref";--> statement-breakpoint
ALTER TABLE "app"."projects" ADD COLUMN "source_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."projects" RENAME CONSTRAINT "rooms_name_nonempty" TO "projects_name_nonempty";--> statement-breakpoint
ALTER TABLE "app"."projects" RENAME CONSTRAINT "rooms_function_key_nonempty" TO "projects_icon_key_nonempty";--> statement-breakpoint
ALTER TABLE "app"."projects" RENAME CONSTRAINT "rooms_sort_order_nonnegative" TO "projects_sort_order_nonnegative";--> statement-breakpoint
ALTER TABLE "app"."projects" RENAME CONSTRAINT "rooms_workspace_id_workspaces_id_fk" TO "projects_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_source_kind_valid" CHECK ("app"."projects"."source_kind" in ('none', 'repository'));--> statement-breakpoint
ALTER INDEX "app"."rooms_workspace_order_idx" RENAME TO "projects_workspace_order_idx";--> statement-breakpoint
ALTER INDEX "app"."rooms_workspace_function_idx" RENAME TO "projects_workspace_icon_idx";--> statement-breakpoint
ALTER TABLE "app"."channels" RENAME COLUMN "room_id" TO "project_id";--> statement-breakpoint
ALTER TABLE "app"."channels" RENAME COLUMN "is_primary_room_channel" TO "is_primary_project_channel";--> statement-breakpoint
ALTER TABLE "app"."channels" RENAME CONSTRAINT "channels_room_id_rooms_id_fk" TO "channels_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "app"."channels" RENAME CONSTRAINT "channels_primary_room_only" TO "channels_primary_project_only";--> statement-breakpoint
ALTER INDEX "app"."channels_active_primary_room_unique" RENAME TO "channels_active_primary_project_unique";--> statement-breakpoint
ALTER INDEX "app"."channels_room_idx" RENAME TO "channels_project_idx";--> statement-breakpoint
ALTER TABLE "app"."tasks" RENAME COLUMN "room_id" TO "project_id";--> statement-breakpoint
ALTER TABLE "app"."tasks" RENAME CONSTRAINT "tasks_room_id_rooms_id_fk" TO "tasks_project_id_projects_id_fk";--> statement-breakpoint
ALTER INDEX "app"."tasks_workspace_room_idx" RENAME TO "tasks_workspace_project_idx";--> statement-breakpoint
ALTER TABLE "app"."agents" RENAME COLUMN "room_id" TO "project_id";--> statement-breakpoint
ALTER TABLE "app"."agents" RENAME CONSTRAINT "agents_room_id_rooms_id_fk" TO "agents_project_id_projects_id_fk";--> statement-breakpoint
ALTER INDEX "app"."agents_workspace_room_idx" RENAME TO "agents_workspace_project_idx";--> statement-breakpoint
-- Primary channels were provisioned idempotently under 'primary-room:<id>'.
UPDATE "app"."channels"
SET "idempotency_key" = 'primary-project:' || substr("idempotency_key", length('primary-room:') + 1)
WHERE "idempotency_key" LIKE 'primary-room:%';
