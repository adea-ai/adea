ALTER TABLE "app"."channels" ADD COLUMN "latest_message_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "message_mentions_user_idx" ON "app"."message_mentions" USING btree ("user_id","message_id") WHERE "app"."message_mentions"."principal_kind" = 'user' and "app"."message_mentions"."user_id" is not null;--> statement-breakpoint
ALTER TABLE "app"."channels" ADD CONSTRAINT "channels_latest_message_sequence_nonnegative" CHECK ("app"."channels"."latest_message_sequence" >= 0);--> statement-breakpoint
UPDATE "app"."channels" AS "channel"
SET "latest_message_sequence" = "latest"."sequence"
FROM (
  SELECT "m"."channel_id", max("m"."sequence") AS "sequence"
  FROM "app"."messages" AS "m"
  WHERE "m"."thread_root_message_id" IS NULL AND "m"."deleted_at" IS NULL
  GROUP BY "m"."channel_id"
) AS "latest"
WHERE "channel"."id" = "latest"."channel_id";
