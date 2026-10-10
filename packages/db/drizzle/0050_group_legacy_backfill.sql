-- Backfill canonical group grants and admissions for channels that predate
-- grant-gated creation. Every existing group member keeps exactly the
-- visibility they already had: founders and members are admitted at sequence
-- 0 under implicit membership grants, so no history is newly exposed and no
-- existing read goes dark under the shared join-point gate. Later joins,
-- revocation and sharing all flow through the live grant rows from here on.
INSERT INTO "app"."group_audience_grants" ("workspace_id", "channel_id", "grant_id", "revision", "user_id", "issued_at", "expires_at", "revoked_at")
SELECT DISTINCT
  "channel_participants"."workspace_id",
  "channel_participants"."channel_id",
  'implicit:member:' || "channel_participants"."user_id",
  1,
  "channel_participants"."user_id",
  to_char("channels"."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  NULL,
  NULL
FROM "app"."channel_participants"
INNER JOIN "app"."channels"
  ON "channels"."id" = "channel_participants"."channel_id"
  AND "channels"."workspace_id" = "channel_participants"."workspace_id"
WHERE "channel_participants"."principal_kind" = 'user'
  AND "channels"."kind" = 'group'
  AND "channels"."lifecycle_state" = 'active'
ON CONFLICT ("channel_id", "grant_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "app"."group_enlistment_grants" ("workspace_id", "channel_id", "grant_id", "revision", "agent_id", "issued_at", "expires_at", "revoked_at")
SELECT DISTINCT
  "channel_participants"."workspace_id",
  "channel_participants"."channel_id",
  'implicit:member:' || "channel_participants"."agent_id",
  1,
  "channel_participants"."agent_id",
  to_char("channels"."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  NULL,
  NULL
FROM "app"."channel_participants"
INNER JOIN "app"."channels"
  ON "channels"."id" = "channel_participants"."channel_id"
  AND "channels"."workspace_id" = "channel_participants"."workspace_id"
WHERE "channel_participants"."principal_kind" = 'agent'
  AND "channels"."kind" = 'group'
  AND "channels"."lifecycle_state" = 'active'
ON CONFLICT ("channel_id", "grant_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "app"."group_admissions" ("workspace_id", "channel_id", "principal_kind", "user_id", "agent_id", "joined_sequence", "joined_at", "auth_group_id", "auth_grant_id", "auth_revision")
SELECT DISTINCT
  "channel_participants"."workspace_id",
  "channel_participants"."channel_id",
  "channel_participants"."principal_kind",
  "channel_participants"."user_id",
  "channel_participants"."agent_id",
  0,
  to_char("channels"."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "channel_participants"."channel_id"::text,
  CASE WHEN "channel_participants"."principal_kind" = 'user'
    THEN 'implicit:member:' || "channel_participants"."user_id"
    ELSE 'implicit:member:' || "channel_participants"."agent_id"
  END,
  1
FROM "app"."channel_participants"
INNER JOIN "app"."channels"
  ON "channels"."id" = "channel_participants"."channel_id"
  AND "channels"."workspace_id" = "channel_participants"."workspace_id"
WHERE "channels"."kind" = 'group'
  AND "channels"."lifecycle_state" = 'active'
ON CONFLICT DO NOTHING;
