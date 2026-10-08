CREATE TABLE "app"."lead_turn_runtime" (
	"intent_id" uuid PRIMARY KEY NOT NULL,
	"dispatch_id" text,
	"execution_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"selection_ref" text NOT NULL,
	"selection_revision" bigint NOT NULL,
	"preparation_ref" text NOT NULL,
	"preparation_expires_at" timestamp with time zone NOT NULL,
	"runtime_session_id" text,
	"state" text DEFAULT 'prepared' NOT NULL,
	"observed_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"published_message_id" uuid,
	"publication_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_turn_runtime_dispatch_unique" UNIQUE("dispatch_id"),
	CONSTRAINT "lead_turn_runtime_attempt_unique" UNIQUE("attempt_id"),
	CONSTRAINT "lead_turn_runtime_execution_valid" CHECK ("app"."lead_turn_runtime"."execution_id" ~ '^exe_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "lead_turn_runtime_attempt_valid" CHECK ("app"."lead_turn_runtime"."attempt_id" ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "lead_turn_runtime_selection_valid" CHECK ("app"."lead_turn_runtime"."selection_ref" ~ '^msel_[a-f0-9]{32}$' and "app"."lead_turn_runtime"."selection_revision" between 1 and 9007199254740991),
	CONSTRAINT "lead_turn_runtime_preparation_valid" CHECK ("app"."lead_turn_runtime"."preparation_ref" ~ '^prep_[a-f0-9]{32}$'),
	CONSTRAINT "lead_turn_runtime_binding_valid" CHECK (("app"."lead_turn_runtime"."dispatch_id" is null and "app"."lead_turn_runtime"."runtime_session_id" is null) or ("app"."lead_turn_runtime"."dispatch_id" is not null and "app"."lead_turn_runtime"."runtime_session_id" is not null and "app"."lead_turn_runtime"."dispatch_id" ~ '^dispatch_[a-f0-9]{32}$' and "app"."lead_turn_runtime"."runtime_session_id" ~ '^ses_[0-9A-HJKMNP-TV-Z]{26}$')),
	CONSTRAINT "lead_turn_runtime_state_valid" CHECK ("app"."lead_turn_runtime"."state" in ('prepared','dispatch_pending','starting','running','awaiting_input','cancelling','completed','failed','cancelled','timed_out','unknown')),
	CONSTRAINT "lead_turn_runtime_observation_valid" CHECK ("app"."lead_turn_runtime"."state" in ('prepared','dispatch_pending') or ("app"."lead_turn_runtime"."dispatch_id" is not null and "app"."lead_turn_runtime"."observed_at" is not null)),
	CONSTRAINT "lead_turn_runtime_publication_valid" CHECK (("app"."lead_turn_runtime"."published_message_id" is null and "app"."lead_turn_runtime"."publication_digest" is null) or ("app"."lead_turn_runtime"."published_message_id" is not null and "app"."lead_turn_runtime"."publication_digest" is not null and "app"."lead_turn_runtime"."publication_digest" ~ '^[a-f0-9]{64}$' and "app"."lead_turn_runtime"."state" = 'completed'))
);
--> statement-breakpoint
ALTER TABLE "app"."lead_turn_runtime" ADD CONSTRAINT "lead_turn_runtime_intent_id_lead_turn_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "app"."lead_turn_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_runtime" ADD CONSTRAINT "lead_turn_runtime_published_message_id_messages_id_fk" FOREIGN KEY ("published_message_id") REFERENCES "app"."messages"("id") ON DELETE restrict ON UPDATE no action;
