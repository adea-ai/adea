CREATE TABLE "app"."sim_workspace_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_workspace_allowlist_workspace_surface_unique" UNIQUE("workspace_id","surface"),
	CONSTRAINT "sim_workspace_allowlist_surface_closed" CHECK ("app"."sim_workspace_allowlist"."surface" in ('hq', 'room-designer', 'character-designer'))
);
--> statement-breakpoint
ALTER TABLE "app"."sim_workspace_allowlist" ADD CONSTRAINT "sim_workspace_allowlist_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;