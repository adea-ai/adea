CREATE TYPE "app"."content_availability" AS ENUM('available', 'offline', 'missing', 'deleted');--> statement-breakpoint
CREATE TYPE "app"."content_sensitivity" AS ENUM('sensitive', 'restricted');--> statement-breakpoint
CREATE TYPE "app"."content_storage_policy" AS ENUM('local_authority');--> statement-breakpoint
CREATE TYPE "app"."content_synchronization_policy" AS ENUM('local_only', 'e2e_optional');--> statement-breakpoint
CREATE TYPE "app"."content_type" AS ENUM('message_body', 'task_objective', 'task_input', 'private_field');--> statement-breakpoint
CREATE TABLE "app"."content_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid,
	"message_id" uuid,
	"content_type" "app"."content_type" NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"digest_sha256" text NOT NULL,
	"sensitivity" "app"."content_sensitivity" NOT NULL,
	"storage_policy" "app"."content_storage_policy" NOT NULL,
	"synchronization_policy" "app"."content_synchronization_policy" NOT NULL,
	"availability" "app"."content_availability" NOT NULL,
	"schema_version" integer NOT NULL,
	"key_version" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_refs_revision_positive" CHECK ("app"."content_refs"."revision" > 0),
	CONSTRAINT "content_refs_schema_version_positive" CHECK ("app"."content_refs"."schema_version" > 0),
	CONSTRAINT "content_refs_key_version_positive" CHECK ("app"."content_refs"."key_version" > 0),
	CONSTRAINT "content_refs_digest_sha256" CHECK ("app"."content_refs"."digest_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_refs_association_consistent" CHECK (("app"."content_refs"."content_type" in ('task_objective', 'task_input') and "app"."content_refs"."message_id" is null) or ("app"."content_refs"."content_type" = 'message_body' and "app"."content_refs"."task_id" is null) or "app"."content_refs"."content_type" = 'private_field'),
	CONSTRAINT "content_refs_deletion_consistent" CHECK (("app"."content_refs"."availability" = 'deleted' and "app"."content_refs"."deleted_at" is not null) or ("app"."content_refs"."availability" <> 'deleted' and "app"."content_refs"."deleted_at" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."tasks" DROP CONSTRAINT "tasks_objective_nonempty";--> statement-breakpoint
ALTER TABLE "app"."tasks" ALTER COLUMN "objective" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "objective_content_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."content_refs" ADD CONSTRAINT "content_refs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "app"."content_refs" ("id", "workspace_id", "message_id", "content_type", "revision", "digest_sha256", "sensitivity", "storage_policy", "synchronization_policy", "availability", "schema_version", "key_version", "created_at", "updated_at")
SELECT DISTINCT ON ("body_content_ref_id") "body_content_ref_id", "workspace_id", "id", 'message_body', 1, repeat('0', 64), 'restricted', 'local_authority', 'local_only', 'missing', 1, 1, "created_at", "updated_at"
FROM "app"."messages"
WHERE "body_content_ref_id" IS NOT NULL
ORDER BY "body_content_ref_id", "created_at", "id";--> statement-breakpoint
CREATE INDEX "content_refs_workspace_availability_idx" ON "app"."content_refs" USING btree ("workspace_id","availability","updated_at");--> statement-breakpoint
CREATE INDEX "content_refs_task_idx" ON "app"."content_refs" USING btree ("workspace_id","task_id");--> statement-breakpoint
CREATE INDEX "content_refs_message_idx" ON "app"."content_refs" USING btree ("workspace_id","message_id");--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_body_content_ref_id_content_refs_id_fk" FOREIGN KEY ("body_content_ref_id") REFERENCES "app"."content_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_objective_content_ref_id_content_refs_id_fk" FOREIGN KEY ("objective_content_ref_id") REFERENCES "app"."content_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_objective_available" CHECK (("app"."tasks"."objective" is not null and length(btrim("app"."tasks"."objective")) > 0 and "app"."tasks"."objective_content_ref_id" is null) or ("app"."tasks"."objective" is null and "app"."tasks"."objective_content_ref_id" is not null));
