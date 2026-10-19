CREATE TABLE "app"."sim_launch_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_digest" text NOT NULL,
	"workspace_id" text NOT NULL,
	"surface" text NOT NULL,
	"bridge_id" text NOT NULL,
	"origin" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_launch_codes_code_digest_unique" UNIQUE("code_digest"),
	CONSTRAINT "sim_launch_codes_digest_nonempty" CHECK (length("app"."sim_launch_codes"."code_digest") > 0),
	CONSTRAINT "sim_launch_codes_surface_closed" CHECK ("app"."sim_launch_codes"."surface" in ('hq', 'room-designer', 'character-designer')),
	CONSTRAINT "sim_launch_codes_workspace_nonempty" CHECK (length("app"."sim_launch_codes"."workspace_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."sim_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_digest" text NOT NULL,
	"launch_code_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"surface" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_sessions_session_digest_unique" UNIQUE("session_digest"),
	CONSTRAINT "sim_sessions_launch_code_unique" UNIQUE("launch_code_id"),
	CONSTRAINT "sim_sessions_digest_nonempty" CHECK (length("app"."sim_sessions"."session_digest") > 0),
	CONSTRAINT "sim_sessions_surface_closed" CHECK ("app"."sim_sessions"."surface" in ('hq', 'room-designer', 'character-designer')),
	CONSTRAINT "sim_sessions_workspace_nonempty" CHECK (length("app"."sim_sessions"."workspace_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."sim_sessions" ADD CONSTRAINT "sim_sessions_launch_code_id_sim_launch_codes_id_fk" FOREIGN KEY ("launch_code_id") REFERENCES "app"."sim_launch_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_launch_codes_expiry_idx" ON "app"."sim_launch_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sim_sessions_workspace_active_idx" ON "app"."sim_sessions" USING btree ("workspace_id","expires_at");