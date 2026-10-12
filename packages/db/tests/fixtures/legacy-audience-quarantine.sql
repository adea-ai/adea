-- Legacy-audience quarantine tooling for the #1222 cutover rehearsal.
--
-- This is NOT a drizzle migration and is not in the migrations folder: it takes no migration
-- number, is not part of the canonical journal, and must not be applied to any live or production
-- database. It is applied only by tests/fixtures/legacy-audience-quarantine.ts to disposable
-- rehearsal databases. Root must assign any migration number before it can ever be activated.
--
-- It is additive: it creates one quarantine table, one helper function and three before-insert
-- triggers. It does not alter any column of the #1232-owned group tables, and it never edits or
-- deletes a channel_participants row (the original legacy record).

CREATE TABLE IF NOT EXISTS "app"."legacy_audience_quarantine" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "principal_kind" "app"."conversation_principal_kind" NOT NULL,
  "principal_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "source_participant_id" uuid NOT NULL,
  "source_row_digest" text NOT NULL,
  "source_channel_created_at" text NOT NULL,
  "source_joined_at" text NOT NULL,
  "profile" text NOT NULL,
  "observed_at" text NOT NULL,
  "withdrawn_admissions" integer,
  "withdrawn_audience_grants" integer,
  "withdrawn_enlistment_grants" integer,
  "withdrawn_digest" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legacy_audience_quarantine_principal_unique"
    UNIQUE ("workspace_id", "channel_id", "principal_kind", "principal_id"),
  CONSTRAINT "legacy_audience_quarantine_reason_known"
    CHECK ("reason" IN ('group_channel_not_active', 'user_not_workspace_member', 'agent_workspace_mismatch')),
  CONSTRAINT "legacy_audience_quarantine_profile_nonempty" CHECK (length(btrim("profile")) > 0),
  CONSTRAINT "legacy_audience_quarantine_withdrawal_complete"
    CHECK (("withdrawn_digest" IS NULL) = ("withdrawn_admissions" IS NULL)
      AND ("withdrawn_digest" IS NULL) = ("withdrawn_audience_grants" IS NULL)
      AND ("withdrawn_digest" IS NULL) = ("withdrawn_enlistment_grants" IS NULL))
);

-- The digest of one legacy participant row: the original record's identity and fields, hashed.
-- Stable across runs because it reads only the row itself.
CREATE OR REPLACE FUNCTION "app"."legacy_participant_digest"("cp" "app"."channel_participants")
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'id', cp.id,
    'workspaceId', cp.workspace_id,
    'channelId', cp.channel_id,
    'principalKind', cp.principal_kind,
    'userId', cp.user_id,
    'agentId', cp.agent_id,
    'createdAt', to_char(cp.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(cp.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text, 'UTF8')), 'hex')
$$;

-- Refuses (or, during a backfill replay, silently skips) any admission or grant for a principal
-- that holds a quarantine record in that channel. The replay setting is set only by the tooling,
-- inside its own transaction; product writes never set it, so they are refused.
CREATE OR REPLACE FUNCTION "app"."legacy_audience_withhold"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_json jsonb := to_jsonb(NEW);
  principal_kind_value "app"."conversation_principal_kind";
  principal_value uuid;
  quarantined_reason text;
BEGIN
  IF row_json ? 'principal_kind' THEN
    principal_kind_value := (row_json ->> 'principal_kind')::"app"."conversation_principal_kind";
  ELSIF row_json ? 'agent_id' THEN
    principal_kind_value := 'agent';
  ELSE
    principal_kind_value := 'user';
  END IF;
  principal_value := CASE
    WHEN principal_kind_value = 'agent' THEN (row_json ->> 'agent_id')::uuid
    ELSE (row_json ->> 'user_id')::uuid
  END;

  SELECT q."reason" INTO quarantined_reason
  FROM "app"."legacy_audience_quarantine" q
  WHERE q."workspace_id" = (row_json ->> 'workspace_id')::uuid
    AND q."channel_id" = (row_json ->> 'channel_id')::uuid
    AND q."principal_kind" = principal_kind_value
    AND q."principal_id" = principal_value;

  IF quarantined_reason IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_setting('adea.legacy_backfill_replay', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'legacy audience is quarantined (%): admission and grants are withheld', quarantined_reason
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS "legacy_audience_withhold" ON "app"."group_admissions";
CREATE TRIGGER "legacy_audience_withhold" BEFORE INSERT ON "app"."group_admissions"
  FOR EACH ROW EXECUTE FUNCTION "app"."legacy_audience_withhold"();

DROP TRIGGER IF EXISTS "legacy_audience_withhold" ON "app"."group_audience_grants";
CREATE TRIGGER "legacy_audience_withhold" BEFORE INSERT ON "app"."group_audience_grants"
  FOR EACH ROW EXECUTE FUNCTION "app"."legacy_audience_withhold"();

DROP TRIGGER IF EXISTS "legacy_audience_withhold" ON "app"."group_enlistment_grants";
CREATE TRIGGER "legacy_audience_withhold" BEFORE INSERT ON "app"."group_enlistment_grants"
  FOR EACH ROW EXECUTE FUNCTION "app"."legacy_audience_withhold"();
