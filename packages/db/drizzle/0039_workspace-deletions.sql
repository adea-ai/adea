CREATE TABLE "app"."workspace_deletions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."workspace_deletions" ADD CONSTRAINT "workspace_deletions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_deletions_owner_idx" ON "app"."workspace_deletions" USING btree ("owner_user_id");
--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "control_plane_used_at" timestamp with time zone;
--> statement-breakpoint
-- Existing scopes predate external-ownership tracking. Never assume them empty.
UPDATE "app"."workspaces" SET "control_plane_used_at" = now();
