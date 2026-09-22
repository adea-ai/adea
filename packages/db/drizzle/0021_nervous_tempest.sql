CREATE TYPE "app"."content_replica_availability" AS ENUM('available', 'offline', 'missing', 'deleted');--> statement-breakpoint
CREATE TYPE "app"."content_replica_kind" AS ENUM('local_authority', 'self_hosted_authority', 'agent_hq_e2ee_sync');--> statement-breakpoint
ALTER TYPE "app"."content_synchronization_policy" ADD VALUE 'agent_hq_e2ee_sync';--> statement-breakpoint
CREATE TABLE "app"."content_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_ref_id" uuid NOT NULL,
	"replica_kind" "app"."content_replica_kind" NOT NULL,
	"revision" integer NOT NULL,
	"digest_sha256" text NOT NULL,
	"schema_version" integer NOT NULL,
	"key_epoch_id" uuid,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"availability" "app"."content_replica_availability" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_replicas_revision_positive" CHECK ("app"."content_replicas"."revision" > 0),
	CONSTRAINT "content_replicas_schema_version_positive" CHECK ("app"."content_replicas"."schema_version" > 0),
	CONSTRAINT "content_replicas_digest_sha256" CHECK ("app"."content_replicas"."digest_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_replicas_nonce_base64url" CHECK ("app"."content_replicas"."nonce" ~ '^[A-Za-z0-9_-]{16}$'),
	CONSTRAINT "content_replicas_ciphertext_base64url" CHECK ("app"."content_replicas"."ciphertext" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "content_replicas_deletion_consistent" CHECK (("app"."content_replicas"."availability" = 'deleted' and "app"."content_replicas"."deleted_at" is not null) or ("app"."content_replicas"."availability" <> 'deleted' and "app"."content_replicas"."deleted_at" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."content_replicas" ADD CONSTRAINT "content_replicas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."content_replicas" ADD CONSTRAINT "content_replicas_content_ref_id_content_refs_id_fk" FOREIGN KEY ("content_ref_id") REFERENCES "app"."content_refs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_replicas_epoch_identity_idx" ON "app"."content_replicas" USING btree ("content_ref_id","revision","replica_kind","key_epoch_id") WHERE "app"."content_replicas"."key_epoch_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "content_replicas_no_epoch_identity_idx" ON "app"."content_replicas" USING btree ("content_ref_id","revision","replica_kind") WHERE "app"."content_replicas"."key_epoch_id" is null;--> statement-breakpoint
CREATE INDEX "content_replicas_workspace_ref_revision_idx" ON "app"."content_replicas" USING btree ("workspace_id","content_ref_id","revision");--> statement-breakpoint
CREATE INDEX "content_replicas_workspace_kind_idx" ON "app"."content_replicas" USING btree ("workspace_id","replica_kind","updated_at");