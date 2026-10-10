CREATE TABLE "app"."addressed_agent_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"parent_turn_id" uuid,
	"agent_id" uuid NOT NULL,
	"addresser_user_id" uuid NOT NULL,
	"addressed_label" text NOT NULL,
	"causal_id" text NOT NULL,
	"dispatch_revision" integer NOT NULL,
	"depth" integer NOT NULL,
	"max_depth" integer NOT NULL,
	"max_turns" integer NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"response_message_id" uuid,
	"intent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "addressed_agent_turns_claim_unique" UNIQUE("trigger_message_id","agent_id","dispatch_revision"),
	CONSTRAINT "addressed_agent_turns_causal_unique" UNIQUE("causal_id"),
	CONSTRAINT "addressed_agent_turns_revision_valid" CHECK ("app"."addressed_agent_turns"."dispatch_revision" between 1 and 9007199254740991),
	CONSTRAINT "addressed_agent_turns_depth_valid" CHECK ("app"."addressed_agent_turns"."depth" >= 0 and "app"."addressed_agent_turns"."max_depth" >= 0 and "app"."addressed_agent_turns"."max_turns" >= 1),
	CONSTRAINT "addressed_agent_turns_label_valid" CHECK (length(btrim("app"."addressed_agent_turns"."addressed_label")) > 0),
	CONSTRAINT "addressed_agent_turns_state_valid" CHECK ("app"."addressed_agent_turns"."state" in ('claimed','dispatching','responded','superseded','cancelled')),
	CONSTRAINT "addressed_agent_turns_response_valid" CHECK (("app"."addressed_agent_turns"."state" = 'responded' and "app"."addressed_agent_turns"."response_message_id" is not null) or ("app"."addressed_agent_turns"."state" != 'responded' and "app"."addressed_agent_turns"."response_message_id" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."addressed_agent_turns" ADD CONSTRAINT "addressed_agent_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."addressed_agent_turns" ADD CONSTRAINT "addressed_agent_turns_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."addressed_agent_turns" ADD CONSTRAINT "addressed_agent_turns_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "app"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."addressed_agent_turns" ADD CONSTRAINT "addressed_agent_turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."addressed_agent_turns" ADD CONSTRAINT "addressed_agent_turns_addresser_user_id_users_id_fk" FOREIGN KEY ("addresser_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."addressed_agent_turns" ADD CONSTRAINT "addressed_agent_turns_response_message_id_messages_id_fk" FOREIGN KEY ("response_message_id") REFERENCES "app"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."addressed_agent_turns" ADD CONSTRAINT "addressed_agent_turns_intent_id_lead_turn_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "app"."lead_turn_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addressed_agent_turns_channel_idx" ON "app"."addressed_agent_turns" USING btree ("workspace_id","channel_id");