CREATE TABLE "app"."lead_child_publications" (
	"intent_id" uuid NOT NULL,
	"delegation_id" text NOT NULL,
	"child_execution_id" text NOT NULL,
	"child_attempt_id" text NOT NULL,
	"outcome_digest" text NOT NULL,
	"message_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_child_publications_intent_id_delegation_id_pk" PRIMARY KEY("intent_id","delegation_id"),
	CONSTRAINT "lead_child_publications_delegation_valid" CHECK ("app"."lead_child_publications"."delegation_id" ~ '^dlg_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "lead_child_publications_execution_valid" CHECK ("app"."lead_child_publications"."child_execution_id" ~ '^exe_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "lead_child_publications_attempt_valid" CHECK ("app"."lead_child_publications"."child_attempt_id" ~ '^att_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "lead_child_publications_digest_valid" CHECK ("app"."lead_child_publications"."outcome_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app"."lead_child_publications" ADD CONSTRAINT "lead_child_publications_intent_id_lead_turn_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "app"."lead_turn_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_child_publications" ADD CONSTRAINT "lead_child_publications_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE restrict ON UPDATE no action;