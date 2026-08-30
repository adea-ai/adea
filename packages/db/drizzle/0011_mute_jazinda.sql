CREATE TYPE "app"."artifact_availability" AS ENUM('pending', 'available', 'unavailable', 'quarantined', 'failed');--> statement-breakpoint
CREATE TYPE "app"."artifact_deletion_state" AS ENUM('active', 'deleted');--> statement-breakpoint
CREATE TYPE "app"."artifact_location_type" AS ENUM('object_store', 'runtime_node', 'external_harness');--> statement-breakpoint
CREATE TYPE "app"."artifact_principal_kind" AS ENUM('user', 'service', 'runtime_node', 'agent', 'worker', 'system');--> statement-breakpoint
CREATE TYPE "app"."artifact_retention_policy" AS ENUM('ephemeral', 'standard', 'retain');--> statement-breakpoint
CREATE TYPE "app"."artifact_sensitivity" AS ENUM('workspace', 'sensitive', 'restricted');--> statement-breakpoint
CREATE TABLE "app"."artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_principal_kind" "app"."artifact_principal_kind" NOT NULL,
	"owner_principal_id" text NOT NULL,
	"source_principal_kind" "app"."artifact_principal_kind" NOT NULL,
	"source_principal_id" text NOT NULL,
	"task_id" uuid,
	"agent_id" uuid,
	"execution_ref" text,
	"location_type" "app"."artifact_location_type" NOT NULL,
	"location_ref" text NOT NULL,
	"runtime_node_id" text,
	"external_harness_id" text,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitivity" "app"."artifact_sensitivity" DEFAULT 'workspace' NOT NULL,
	"retention_policy" "app"."artifact_retention_policy" DEFAULT 'standard' NOT NULL,
	"availability" "app"."artifact_availability" DEFAULT 'pending' NOT NULL,
	"deletion_state" "app"."artifact_deletion_state" DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_principal_kind" "app"."artifact_principal_kind",
	"deleted_by_principal_id" text,
	"source_artifact_ref" text NOT NULL,
	"create_payload_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_workspace_source_unique" UNIQUE("workspace_id","source_artifact_ref"),
	CONSTRAINT "artifacts_owner_principal_nonempty" CHECK (length(btrim("app"."artifacts"."owner_principal_id")) > 0),
	CONSTRAINT "artifacts_source_principal_nonempty" CHECK (length(btrim("app"."artifacts"."source_principal_id")) > 0),
	CONSTRAINT "artifacts_source_ref_nonempty" CHECK (length(btrim("app"."artifacts"."source_artifact_ref")) > 0),
	CONSTRAINT "artifacts_location_ref_nonempty" CHECK (length(btrim("app"."artifacts"."location_ref")) > 0),
	CONSTRAINT "artifacts_filename_nonempty" CHECK (length(btrim("app"."artifacts"."filename")) > 0),
	CONSTRAINT "artifacts_media_type_nonempty" CHECK (length(btrim("app"."artifacts"."media_type")) > 0),
	CONSTRAINT "artifacts_size_nonnegative" CHECK ("app"."artifacts"."size_bytes" >= 0),
	CONSTRAINT "artifacts_checksum_sha256" CHECK ("app"."artifacts"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifacts_version_positive" CHECK ("app"."artifacts"."version" > 0),
	CONSTRAINT "artifacts_location_consistent" CHECK (("app"."artifacts"."location_type" = 'object_store' and "app"."artifacts"."runtime_node_id" is null and "app"."artifacts"."external_harness_id" is null) or ("app"."artifacts"."location_type" = 'runtime_node' and length(btrim("app"."artifacts"."runtime_node_id")) > 0 and "app"."artifacts"."external_harness_id" is null) or ("app"."artifacts"."location_type" = 'external_harness' and "app"."artifacts"."runtime_node_id" is null and length(btrim("app"."artifacts"."external_harness_id")) > 0)),
	CONSTRAINT "artifacts_deletion_consistent" CHECK (("app"."artifacts"."deletion_state" = 'active' and "app"."artifacts"."deleted_at" is null and "app"."artifacts"."deleted_by_principal_kind" is null and "app"."artifacts"."deleted_by_principal_id" is null) or ("app"."artifacts"."deletion_state" = 'deleted' and "app"."artifacts"."deleted_at" is not null and "app"."artifacts"."deleted_by_principal_kind" is not null and length(btrim("app"."artifacts"."deleted_by_principal_id")) > 0))
);
--> statement-breakpoint
ALTER TABLE "app"."artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."artifacts" ADD CONSTRAINT "artifacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_workspace_lifecycle_idx" ON "app"."artifacts" USING btree ("workspace_id","deletion_state","availability","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_task_idx" ON "app"."artifacts" USING btree ("workspace_id","task_id");--> statement-breakpoint
CREATE INDEX "artifacts_agent_idx" ON "app"."artifacts" USING btree ("workspace_id","agent_id");--> statement-breakpoint
CREATE INDEX "artifacts_execution_idx" ON "app"."artifacts" USING btree ("workspace_id","execution_ref");--> statement-breakpoint
ALTER TABLE "app"."message_artifact_references" ADD CONSTRAINT "message_artifact_references_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "app"."artifacts"("id") ON DELETE restrict ON UPDATE no action;