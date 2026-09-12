CREATE TYPE "app"."workspace_event_actor_kind" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "app"."workspace_event_aggregate_type" AS ENUM('workspace', 'room', 'channel', 'message', 'task', 'agent', 'artifact', 'content_ref');--> statement-breakpoint
CREATE TABLE "app"."workspace_event_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"workspace_sequence" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_event_dispatches_attempts_nonnegative" CHECK ("app"."workspace_event_dispatches"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."workspace_event_sequences" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_event_sequences_nonnegative" CHECK ("app"."workspace_event_sequences"."last_sequence" >= 0)
);
--> statement-breakpoint
DROP INDEX "app"."workspace_events_replay_idx";--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD COLUMN "workspace_sequence" bigint;--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD COLUMN "schema_version" integer;--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD COLUMN "aggregate_type" "app"."workspace_event_aggregate_type";--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD COLUMN "aggregate_id" text;--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD COLUMN "actor_kind" "app"."workspace_event_actor_kind";--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD COLUMN "correlation_id" uuid;--> statement-breakpoint
UPDATE "app"."workspace_events"
SET
  "workspace_sequence" = ranked.position,
  "schema_version" = 1,
  "aggregate_type" = CASE
    WHEN "event_type" LIKE 'agent.%' THEN 'agent'::"app"."workspace_event_aggregate_type"
    WHEN "event_type" LIKE 'artifact.%' THEN 'artifact'::"app"."workspace_event_aggregate_type"
    WHEN "event_type" LIKE 'channel.%' OR "event_type" LIKE 'thread.%' THEN 'channel'::"app"."workspace_event_aggregate_type"
    WHEN "event_type" LIKE 'content.%' THEN 'content_ref'::"app"."workspace_event_aggregate_type"
    WHEN "event_type" LIKE 'message.%' THEN 'message'::"app"."workspace_event_aggregate_type"
    WHEN "event_type" LIKE 'room.%' THEN 'room'::"app"."workspace_event_aggregate_type"
    WHEN "event_type" LIKE 'task.%' THEN 'task'::"app"."workspace_event_aggregate_type"
    ELSE 'workspace'::"app"."workspace_event_aggregate_type"
  END
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "workspace_id" ORDER BY "sequence") AS position
  FROM "app"."workspace_events"
) AS ranked
WHERE "app"."workspace_events"."id" = ranked."id";--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ALTER COLUMN "workspace_sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ALTER COLUMN "schema_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ALTER COLUMN "aggregate_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspace_event_dispatches" ADD CONSTRAINT "workspace_event_dispatches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_event_dispatches" ADD CONSTRAINT "workspace_event_dispatches_event_id_workspace_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."workspace_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_event_sequences" ADD CONSTRAINT "workspace_event_sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_event_dispatches_event_uidx" ON "app"."workspace_event_dispatches" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "workspace_event_dispatches_pending_idx" ON "app"."workspace_event_dispatches" USING btree ("workspace_id","workspace_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_events_workspace_sequence_uidx" ON "app"."workspace_events" USING btree ("workspace_id","workspace_sequence");--> statement-breakpoint
CREATE INDEX "workspace_events_replay_idx" ON "app"."workspace_events" USING btree ("workspace_id","workspace_sequence");--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD CONSTRAINT "workspace_events_workspace_sequence_positive" CHECK ("app"."workspace_events"."workspace_sequence" > 0);--> statement-breakpoint
ALTER TABLE "app"."workspace_events" ADD CONSTRAINT "workspace_events_schema_version_positive" CHECK ("app"."workspace_events"."schema_version" > 0);
--> statement-breakpoint
INSERT INTO "app"."workspace_event_sequences" ("workspace_id", "last_sequence")
SELECT "workspace_id", max("workspace_sequence") FROM "app"."workspace_events" GROUP BY "workspace_id"
ON CONFLICT ("workspace_id") DO UPDATE SET "last_sequence" = greatest("app"."workspace_event_sequences"."last_sequence", excluded."last_sequence");--> statement-breakpoint
INSERT INTO "app"."workspace_event_dispatches" ("workspace_id", "event_id", "workspace_sequence", "notified_at")
SELECT "workspace_id", "id", "workspace_sequence", now() FROM "app"."workspace_events"
ON CONFLICT ("event_id") DO NOTHING;
