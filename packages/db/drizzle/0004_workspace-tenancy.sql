CREATE TYPE "app"."workspace_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "app"."authorization_audit_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"permission" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorization_audit_decision_valid" CHECK ("app"."authorization_audit_records"."decision" in ('allowed', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "app"."temporary_user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temporary_user_sessions_credential_digest_unique" UNIQUE("credential_digest"),
	CONSTRAINT "temporary_user_sessions_credential_digest_nonempty" CHECK (length(btrim("app"."temporary_user_sessions"."credential_digest")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."workspace_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "app"."workspace_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memberships_workspace_user_unique" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "is_temporary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "scene" text DEFAULT 'home' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
DO $agent_hq$
DECLARE
	migration_user_id uuid;
BEGIN
	IF EXISTS (SELECT 1 FROM "app"."workspaces") THEN
		INSERT INTO "app"."users" ("display_name", "is_temporary")
		VALUES ('Migrated workspace owner', true)
		RETURNING "id" INTO migration_user_id;
		UPDATE "app"."workspaces"
		SET "owner_user_id" = migration_user_id,
			"idempotency_key" = 'migrated:' || "id"::text;
	END IF;
END
$agent_hq$;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."authorization_audit_records" ADD CONSTRAINT "authorization_audit_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."temporary_user_sessions" ADD CONSTRAINT "temporary_user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "app"."workspace_memberships" ("workspace_id", "user_id", "role")
SELECT "id", "owner_user_id", 'owner'::"app"."workspace_role"
FROM "app"."workspaces"
ON CONFLICT ("workspace_id", "user_id") DO NOTHING;--> statement-breakpoint
CREATE INDEX "authorization_audit_workspace_idx" ON "app"."authorization_audit_records" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "authorization_audit_principal_idx" ON "app"."authorization_audit_records" USING btree ("principal_kind","principal_id");--> statement-breakpoint
CREATE INDEX "temporary_user_sessions_user_idx" ON "app"."temporary_user_sessions" USING btree ("user_id","claimed_at");--> statement-breakpoint
CREATE INDEX "temporary_user_sessions_expiry_idx" ON "app"."temporary_user_sessions" USING btree ("expires_at","claimed_at");--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "app"."workspace_memberships" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_workspace_role_idx" ON "app"."workspace_memberships" USING btree ("workspace_id","role");--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspaces_owner_idx" ON "app"."workspaces" USING btree ("owner_user_id","deleted_at");--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_owner_idempotency_unique" UNIQUE("owner_user_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_name_nonempty" CHECK (length(btrim("app"."workspaces"."name")) > 0);--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_idempotency_nonempty" CHECK (length(btrim("app"."workspaces"."idempotency_key")) > 0);--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_scene_valid" CHECK ("app"."workspaces"."scene" in ('home', 'work'));
