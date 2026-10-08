CREATE TABLE "app"."lead_turn_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"control_plane_agent_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"profile_version" text NOT NULL,
	"profile_revision" integer NOT NULL,
	"channel_version" integer NOT NULL,
	"channel_visibility" text NOT NULL,
	"audience" jsonb NOT NULL,
	"dispatch_key" text NOT NULL,
	"state" text DEFAULT 'blocked' NOT NULL,
	"reason_code" text DEFAULT 'ADMISSION_SERVICE_UNAVAILABLE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_turn_intents_message_unique" UNIQUE("message_id"),
	CONSTRAINT "lead_turn_intents_dispatch_key_unique" UNIQUE("dispatch_key"),
	CONSTRAINT "lead_turn_intents_dispatch_key_valid" CHECK ("app"."lead_turn_intents"."dispatch_key" = 'lead-turn:' || "app"."lead_turn_intents"."id"::text),
	CONSTRAINT "lead_turn_intents_profile_revision_valid" CHECK ("app"."lead_turn_intents"."profile_revision" >= 0),
	CONSTRAINT "lead_turn_intents_channel_version_valid" CHECK ("app"."lead_turn_intents"."channel_version" > 0),
	CONSTRAINT "lead_turn_intents_visibility_valid" CHECK ("app"."lead_turn_intents"."channel_visibility" in ('workspace', 'participants')),
	CONSTRAINT "lead_turn_intents_audience_valid" CHECK (jsonb_typeof("app"."lead_turn_intents"."audience") = 'array'),
	CONSTRAINT "lead_turn_intents_blocked_only" CHECK ("app"."lead_turn_intents"."state" = 'blocked' and "app"."lead_turn_intents"."reason_code" = 'ADMISSION_SERVICE_UNAVAILABLE')
);
--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_turn_intents_workspace_channel_idx" ON "app"."lead_turn_intents" USING btree ("workspace_id","channel_id");
