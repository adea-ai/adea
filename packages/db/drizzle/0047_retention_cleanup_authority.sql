CREATE TYPE "app"."retention_category" AS ENUM('messages', 'contexts', 'native_transcripts', 'receipts', 'artifacts', 'memory', 'logs', 'backups');--> statement-breakpoint
CREATE TYPE "app"."retention_cleanup_coverage" AS ENUM('primary', 'runtime_state', 'index', 'cache', 'object_version', 'replica');--> statement-breakpoint
CREATE TYPE "app"."retention_cleanup_operation" AS ENUM('delete', 'read_check');--> statement-breakpoint
CREATE TYPE "app"."retention_cleanup_outcome" AS ENUM('completed', 'in_progress', 'unreachable', 'failed');--> statement-breakpoint
CREATE TABLE "app"."retention_cleanup_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"runtime_node_id" uuid NOT NULL,
	"executor_signing_fingerprint" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"category" "app"."retention_category" NOT NULL,
	"subject_id" text NOT NULL,
	"coverage" "app"."retention_cleanup_coverage" NOT NULL,
	"operation" "app"."retention_cleanup_operation" NOT NULL,
	"outcome" "app"."retention_cleanup_outcome" NOT NULL,
	"residual_count" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_cleanup_receipts_idempotency_bounded" CHECK (char_length("app"."retention_cleanup_receipts"."idempotency_key") between 1 and 128),
	CONSTRAINT "retention_cleanup_receipts_subject_bounded" CHECK (char_length("app"."retention_cleanup_receipts"."subject_id") between 1 and 128),
	CONSTRAINT "retention_cleanup_receipts_residual_nonnegative" CHECK ("app"."retention_cleanup_receipts"."residual_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."retention_deletion_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"category" "app"."retention_category" NOT NULL,
	"subject_id" text NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_deletion_authorizations_subject_bounded" CHECK (char_length("app"."retention_deletion_authorizations"."subject_id") between 1 and 128),
	CONSTRAINT "retention_deletion_authorizations_expiry_after_grant" CHECK ("app"."retention_deletion_authorizations"."expires_at" > "app"."retention_deletion_authorizations"."granted_at"),
	CONSTRAINT "retention_deletion_authorizations_revocation_consistent" CHECK (("app"."retention_deletion_authorizations"."revoked_at" is null) = ("app"."retention_deletion_authorizations"."revoked_by_user_id" is null)
        and ("app"."retention_deletion_authorizations"."revoked_at" is null or "app"."retention_deletion_authorizations"."revoked_at" >= "app"."retention_deletion_authorizations"."granted_at"))
);
--> statement-breakpoint
CREATE TABLE "app"."retention_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"category" "app"."retention_category" NOT NULL,
	"subject_id" text NOT NULL,
	"placed_by_user_id" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_holds_subject_bounded" CHECK (char_length("app"."retention_holds"."subject_id") between 1 and 128),
	CONSTRAINT "retention_holds_release_consistent" CHECK (("app"."retention_holds"."released_at" is null) = ("app"."retention_holds"."released_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."retention_cleanup_receipts" ADD CONSTRAINT "retention_cleanup_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retention_cleanup_receipts" ADD CONSTRAINT "retention_cleanup_receipts_executor_fk" FOREIGN KEY ("workspace_id","runtime_node_id") REFERENCES "app"."runtime_nodes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retention_deletion_authorizations" ADD CONSTRAINT "retention_deletion_authorizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retention_deletion_authorizations" ADD CONSTRAINT "retention_deletion_authorizations_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retention_deletion_authorizations" ADD CONSTRAINT "retention_deletion_authorizations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retention_holds" ADD CONSTRAINT "retention_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retention_holds" ADD CONSTRAINT "retention_holds_placed_by_user_id_users_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retention_holds" ADD CONSTRAINT "retention_holds_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retention_cleanup_receipts_idempotency_uidx" ON "app"."retention_cleanup_receipts" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "retention_cleanup_receipts_subject_idx" ON "app"."retention_cleanup_receipts" USING btree ("workspace_id","category","subject_id","coverage","operation");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_deletion_authorizations_live_uidx" ON "app"."retention_deletion_authorizations" USING btree ("workspace_id","category","subject_id") WHERE "app"."retention_deletion_authorizations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "retention_holds_subject_idx" ON "app"."retention_holds" USING btree ("workspace_id","category","subject_id");