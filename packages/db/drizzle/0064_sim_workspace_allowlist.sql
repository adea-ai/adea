CREATE TABLE "app"."sim_workspace_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"surface" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_workspace_allowlist_workspace_surface_unique" UNIQUE("workspace_id","surface"),
	CONSTRAINT "sim_workspace_allowlist_workspace_nonempty" CHECK (length("app"."sim_workspace_allowlist"."workspace_id") > 0),
	CONSTRAINT "sim_workspace_allowlist_surface_closed" CHECK ("app"."sim_workspace_allowlist"."surface" in ('hq', 'room-designer', 'character-designer'))
);
