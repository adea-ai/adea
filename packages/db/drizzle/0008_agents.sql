CREATE TYPE "app"."agent_lifecycle_state" AS ENUM('active', 'archived', 'configuration_error');--> statement-breakpoint
CREATE TYPE "app"."agent_profile_state" AS ENUM('available', 'deprecated', 'missing');--> statement-breakpoint
CREATE TABLE "app"."agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"room_id" uuid,
	"name" text NOT NULL,
	"role_summary" text,
	"avatar_ref" text,
	"character_ref" text,
	"presentation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lifecycle_state" "app"."agent_lifecycle_state" DEFAULT 'active' NOT NULL,
	"profile_id" text NOT NULL,
	"profile_version" text NOT NULL,
	"profile_state" "app"."agent_profile_state" DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_nonempty" CHECK (length(btrim("app"."agents"."name")) > 0),
	CONSTRAINT "agents_profile_id_nonempty" CHECK (length(btrim("app"."agents"."profile_id")) > 0),
	CONSTRAINT "agents_profile_version_nonempty" CHECK (length(btrim("app"."agents"."profile_version")) > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "app"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_workspace_lifecycle_idx" ON "app"."agents" USING btree ("workspace_id","lifecycle_state","name","id");--> statement-breakpoint
CREATE INDEX "agents_workspace_room_idx" ON "app"."agents" USING btree ("workspace_id","room_id");--> statement-breakpoint
CREATE INDEX "agents_profile_idx" ON "app"."agents" USING btree ("profile_id","profile_version");