CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TYPE "app"."outbox_status" AS ENUM('pending', 'processing', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "app"."command_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "app"."outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."event_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "event_inbox_source_event_unique" UNIQUE("source","source_event_id")
);
--> statement-breakpoint
CREATE TABLE "app"."workspace_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."workspace_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."command_outbox" ADD CONSTRAINT "command_outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD CONSTRAINT "workspace_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "command_outbox_idempotency_uidx" ON "app"."command_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "command_outbox_delivery_idx" ON "app"."command_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "command_outbox_workspace_idx" ON "app"."command_outbox" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "event_inbox_unprocessed_idx" ON "app"."event_inbox" USING btree ("processed_at","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_events_sequence_uidx" ON "app"."workspace_events" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "workspace_events_replay_idx" ON "app"."workspace_events" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "workspace_events_type_idx" ON "app"."workspace_events" USING btree ("workspace_id","event_type");--> statement-breakpoint
CREATE INDEX "workspaces_active_idx" ON "app"."workspaces" USING btree ("deleted_at");
