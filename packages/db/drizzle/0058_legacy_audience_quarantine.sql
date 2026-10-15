CREATE TABLE "app"."legacy_audience_quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"principal_kind" "app"."conversation_principal_kind" NOT NULL,
	"principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"source_participant_id" uuid NOT NULL,
	"source_workspace_id" uuid NOT NULL,
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
	CONSTRAINT "legacy_audience_quarantine_principal_unique" UNIQUE("workspace_id","channel_id","principal_kind","principal_id"),
	CONSTRAINT "legacy_audience_quarantine_source_unique" UNIQUE("source_participant_id"),
	CONSTRAINT "legacy_audience_quarantine_reason_known" CHECK ("app"."legacy_audience_quarantine"."reason" in ('agent_not_active', 'channel_workspace_mismatch', 'group_channel_not_active', 'user_not_workspace_member', 'agent_workspace_mismatch')),
	CONSTRAINT "legacy_audience_quarantine_profile_nonempty" CHECK (length(btrim("app"."legacy_audience_quarantine"."profile")) > 0),
	CONSTRAINT "legacy_audience_quarantine_source_digest_hex" CHECK ("app"."legacy_audience_quarantine"."source_row_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_audience_quarantine_withdrawal_digest_hex" CHECK ("app"."legacy_audience_quarantine"."withdrawn_digest" is null or "app"."legacy_audience_quarantine"."withdrawn_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_audience_quarantine_withdrawal_complete" CHECK (("app"."legacy_audience_quarantine"."withdrawn_digest" is null) = ("app"."legacy_audience_quarantine"."withdrawn_admissions" is null)
        and ("app"."legacy_audience_quarantine"."withdrawn_digest" is null) = ("app"."legacy_audience_quarantine"."withdrawn_audience_grants" is null)
        and ("app"."legacy_audience_quarantine"."withdrawn_digest" is null) = ("app"."legacy_audience_quarantine"."withdrawn_enlistment_grants" is null)),
	CONSTRAINT "legacy_audience_quarantine_withdrawal_counts_nonnegative" CHECK (("app"."legacy_audience_quarantine"."withdrawn_admissions" is null or "app"."legacy_audience_quarantine"."withdrawn_admissions" >= 0)
        and ("app"."legacy_audience_quarantine"."withdrawn_audience_grants" is null or "app"."legacy_audience_quarantine"."withdrawn_audience_grants" >= 0)
        and ("app"."legacy_audience_quarantine"."withdrawn_enlistment_grants" is null or "app"."legacy_audience_quarantine"."withdrawn_enlistment_grants" >= 0))
);
--> statement-breakpoint
ALTER TABLE "app"."legacy_audience_quarantine" ADD CONSTRAINT "legacy_audience_quarantine_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."legacy_audience_quarantine" ADD CONSTRAINT "legacy_audience_quarantine_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_audience_quarantine_channel_idx" ON "app"."legacy_audience_quarantine" USING btree ("workspace_id","channel_id");
--> statement-breakpoint
-- Freeze every input and authority-bearing write while classification, withdrawal and trigger
-- installation run. In particular, do not leave a window where an old roster or membership write
-- can create a new admission after the withdrawal but before the withholding triggers are installed.
-- The migrator holds these locks until the entire migration transaction commits.
LOCK TABLE app.channels, app.channel_participants, app.workspace_memberships, app.agents,
  app.group_admissions, app.group_audience_grants, app.group_enlistment_grants
  IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- JSON encodes timestamptz values in the session timezone. Normalize this migration transaction
-- before hashing withdrawn grant rows so provenance is stable across operator sessions.
SET LOCAL TIME ZONE 'UTC';
--> statement-breakpoint
-- Hash the full source row using stable JSON and UTC microsecond timestamps. The participant row is
-- never edited or deleted by this migration.
CREATE OR REPLACE FUNCTION app.legacy_participant_digest(cp app.channel_participants)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'id', cp.id,
    'workspaceId', cp.workspace_id,
    'channelId', cp.channel_id,
    'principalKind', cp.principal_kind,
    'userId', cp.user_id,
    'agentId', cp.agent_id,
    'createdAt', to_char(cp.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', to_char(cp.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
-- The exact source profile is the canonical 0050 file hash. Quarantine every legacy group row whose
-- audience cannot be proven under its channel's workspace. A participant workspace mismatch is
-- classified explicitly instead of silently skipping the row as 0050 did.
WITH classified AS (
  SELECT
    ch.workspace_id AS channel_workspace_id,
    cp.workspace_id AS source_workspace_id,
    cp.channel_id,
    cp.principal_kind,
    COALESCE(cp.user_id, cp.agent_id) AS principal_id,
    cp.id AS source_participant_id,
    app.legacy_participant_digest(cp) AS source_row_digest,
    to_char(ch.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_channel_created_at,
    to_char(cp.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_joined_at,
    CASE
      WHEN cp.workspace_id <> ch.workspace_id THEN 'channel_workspace_mismatch'
      WHEN ch.lifecycle_state <> 'active' THEN 'group_channel_not_active'
      WHEN cp.principal_kind = 'user' AND NOT EXISTS (
        SELECT 1 FROM app.workspace_memberships wm
        WHERE wm.workspace_id = ch.workspace_id AND wm.user_id = cp.user_id
      ) THEN 'user_not_workspace_member'
      WHEN cp.principal_kind = 'agent' AND NOT EXISTS (
        SELECT 1 FROM app.agents ag
        WHERE ag.id = cp.agent_id AND ag.workspace_id = ch.workspace_id
      ) THEN 'agent_workspace_mismatch'
      WHEN cp.principal_kind = 'agent' AND EXISTS (
        SELECT 1 FROM app.agents ag
        WHERE ag.id = cp.agent_id AND ag.workspace_id = ch.workspace_id
          AND ag.lifecycle_state <> 'active'
      ) THEN 'agent_not_active'
      ELSE NULL
    END AS reason
  FROM app.channel_participants cp
  INNER JOIN app.channels ch ON ch.id = cp.channel_id
  WHERE ch.kind = 'group'
)
INSERT INTO app.legacy_audience_quarantine (
  workspace_id, channel_id, principal_kind, principal_id, reason,
  source_participant_id, source_workspace_id, source_row_digest,
  source_channel_created_at, source_joined_at, profile, observed_at
)
SELECT
  channel_workspace_id, channel_id, principal_kind, principal_id, reason,
  source_participant_id, source_workspace_id, source_row_digest,
  source_channel_created_at, source_joined_at,
  'legacy-group-audience/0050-group-legacy-backfill@dc310c7d6686efee',
  to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
FROM classified
WHERE reason IS NOT NULL
ON CONFLICT (workspace_id, channel_id, principal_kind, principal_id) DO NOTHING;
--> statement-breakpoint
-- Record an exact digest of each derived row before deleting only the rows bound to that quarantined
-- principal. Sharing grants and the original legacy channel_participants rows are not touched.
DO $$
DECLARE
  quarantine_row record;
  admission_count integer;
  audience_count integer;
  enlistment_count integer;
  withdrawn_rows_digest text;
BEGIN
  FOR quarantine_row IN
    SELECT *
    FROM app.legacy_audience_quarantine
    WHERE withdrawn_digest IS NULL
    ORDER BY id
    FOR UPDATE
  LOOP
    SELECT
      count(*) FILTER (WHERE kind = 'admission')::integer,
      count(*) FILTER (WHERE kind = 'audience')::integer,
      count(*) FILTER (WHERE kind = 'enlistment')::integer,
      encode(
        sha256(convert_to(
          COALESCE(string_agg(kind || ':' || row_id || ':' || row_json, E'\n' ORDER BY kind, row_id), ''),
          'UTF8'
        )),
        'hex'
      )
    INTO admission_count, audience_count, enlistment_count, withdrawn_rows_digest
    FROM (
      SELECT 'admission'::text AS kind, a.id::text AS row_id, to_jsonb(a)::text AS row_json
      FROM app.group_admissions a
      WHERE a.workspace_id = quarantine_row.workspace_id
        AND a.channel_id = quarantine_row.channel_id
        AND a.principal_kind = quarantine_row.principal_kind
        AND COALESCE(a.user_id, a.agent_id) = quarantine_row.principal_id
      UNION ALL
      SELECT 'audience'::text, g.id::text, to_jsonb(g)::text
      FROM app.group_audience_grants g
      WHERE quarantine_row.principal_kind = 'user'
        AND g.workspace_id = quarantine_row.workspace_id
        AND g.channel_id = quarantine_row.channel_id
        AND g.user_id = quarantine_row.principal_id
      UNION ALL
      SELECT 'enlistment'::text, g.id::text, to_jsonb(g)::text
      FROM app.group_enlistment_grants g
      WHERE quarantine_row.principal_kind = 'agent'
        AND g.workspace_id = quarantine_row.workspace_id
        AND g.channel_id = quarantine_row.channel_id
        AND g.agent_id = quarantine_row.principal_id
    ) AS doomed;

    DELETE FROM app.group_admissions a
    WHERE a.workspace_id = quarantine_row.workspace_id
      AND a.channel_id = quarantine_row.channel_id
      AND a.principal_kind = quarantine_row.principal_kind
      AND COALESCE(a.user_id, a.agent_id) = quarantine_row.principal_id;
    DELETE FROM app.group_audience_grants g
    WHERE quarantine_row.principal_kind = 'user'
      AND g.workspace_id = quarantine_row.workspace_id
      AND g.channel_id = quarantine_row.channel_id
      AND g.user_id = quarantine_row.principal_id;
    DELETE FROM app.group_enlistment_grants g
    WHERE quarantine_row.principal_kind = 'agent'
      AND g.workspace_id = quarantine_row.workspace_id
      AND g.channel_id = quarantine_row.channel_id
      AND g.agent_id = quarantine_row.principal_id;

    UPDATE app.legacy_audience_quarantine
    SET withdrawn_admissions = admission_count,
        withdrawn_audience_grants = audience_count,
        withdrawn_enlistment_grants = enlistment_count,
        withdrawn_digest = withdrawn_rows_digest
    WHERE id = quarantine_row.id;
  END LOOP;
END
$$;
--> statement-breakpoint
-- Admission and grant rows are authority-bearing. A replay of the historical 0050 backfill must
-- skip quarantined rows; an UPDATE that tries to move an existing row into or out of a quarantined
-- identity is refused. This guard deliberately has no custom-setting bypass.
CREATE OR REPLACE FUNCTION app.legacy_audience_withhold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  row_json jsonb;
  principal_kind_value app.conversation_principal_kind;
  principal_value uuid;
  quarantined_reason text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    row_json := to_jsonb(OLD);
    IF row_json ? 'principal_kind' THEN
      principal_kind_value := (row_json ->> 'principal_kind')::app.conversation_principal_kind;
    ELSIF TG_TABLE_NAME = 'group_enlistment_grants' THEN
      principal_kind_value := 'agent';
    ELSE
      principal_kind_value := 'user';
    END IF;
    principal_value := CASE
      WHEN principal_kind_value = 'agent' THEN (row_json ->> 'agent_id')::uuid
      ELSE (row_json ->> 'user_id')::uuid
    END;
    SELECT q.reason INTO quarantined_reason
    FROM app.legacy_audience_quarantine q
    WHERE q.workspace_id = (row_json ->> 'workspace_id')::uuid
      AND q.channel_id = (row_json ->> 'channel_id')::uuid
      AND q.principal_kind = principal_kind_value
      AND q.principal_id = principal_value;
    IF FOUND THEN
      RAISE EXCEPTION 'legacy audience is quarantined (%): admission and grants are withheld', quarantined_reason
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  row_json := to_jsonb(NEW);
  IF row_json ? 'principal_kind' THEN
    principal_kind_value := (row_json ->> 'principal_kind')::app.conversation_principal_kind;
  ELSIF TG_TABLE_NAME = 'group_enlistment_grants' THEN
    principal_kind_value := 'agent';
  ELSE
    principal_kind_value := 'user';
  END IF;
  principal_value := CASE
    WHEN principal_kind_value = 'agent' THEN (row_json ->> 'agent_id')::uuid
    ELSE (row_json ->> 'user_id')::uuid
  END;
  SELECT q.reason INTO quarantined_reason
  FROM app.legacy_audience_quarantine q
  WHERE q.workspace_id = (row_json ->> 'workspace_id')::uuid
    AND q.channel_id = (row_json ->> 'channel_id')::uuid
    AND q.principal_kind = principal_kind_value
    AND q.principal_id = principal_value;
  IF FOUND THEN
    IF TG_OP = 'INSERT' THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'legacy audience is quarantined (%): admission and grants are withheld', quarantined_reason
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_audience_withhold ON app.group_admissions;
CREATE TRIGGER legacy_audience_withhold BEFORE INSERT OR UPDATE ON app.group_admissions
  FOR EACH ROW EXECUTE FUNCTION app.legacy_audience_withhold();
--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_audience_withhold ON app.group_audience_grants;
CREATE TRIGGER legacy_audience_withhold BEFORE INSERT OR UPDATE ON app.group_audience_grants
  FOR EACH ROW EXECUTE FUNCTION app.legacy_audience_withhold();
--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_audience_withhold ON app.group_enlistment_grants;
CREATE TRIGGER legacy_audience_withhold BEFORE INSERT OR UPDATE ON app.group_enlistment_grants
  FOR EACH ROW EXECUTE FUNCTION app.legacy_audience_withhold();
--> statement-breakpoint
-- The old participant rows are the evidence for the quarantine; ordinary runtime writes may neither
-- rewrite nor remove them, nor add the quarantined identity back. Parent-cascade cleanup is allowed.
CREATE OR REPLACE FUNCTION app.legacy_audience_source_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  row_json jsonb;
  principal_id_value uuid;
  quarantined_reason text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    row_json := to_jsonb(OLD);
    principal_id_value := COALESCE((row_json ->> 'user_id')::uuid, (row_json ->> 'agent_id')::uuid);
    SELECT q.reason INTO quarantined_reason
    FROM app.legacy_audience_quarantine q
    WHERE q.source_participant_id = (row_json ->> 'id')::uuid
       OR (q.channel_id = (row_json ->> 'channel_id')::uuid
           AND q.principal_kind = (row_json ->> 'principal_kind')::app.conversation_principal_kind
           AND q.principal_id = principal_id_value);
    IF FOUND THEN
      IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'legacy audience is quarantined (%): source participant is preserved', quarantined_reason
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    row_json := to_jsonb(NEW);
    principal_id_value := COALESCE((row_json ->> 'user_id')::uuid, (row_json ->> 'agent_id')::uuid);
    SELECT q.reason INTO quarantined_reason
    FROM app.legacy_audience_quarantine q
    WHERE q.channel_id = (row_json ->> 'channel_id')::uuid
      AND q.principal_kind = (row_json ->> 'principal_kind')::app.conversation_principal_kind
      AND q.principal_id = principal_id_value;
    IF FOUND THEN
      RAISE EXCEPTION 'legacy audience is quarantined (%): source participant is preserved', quarantined_reason
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_audience_source_immutable ON app.channel_participants;
CREATE TRIGGER legacy_audience_source_immutable BEFORE INSERT OR UPDATE OR DELETE ON app.channel_participants
  FOR EACH ROW EXECUTE FUNCTION app.legacy_audience_source_immutable();
--> statement-breakpoint
-- Quarantine records are migration-owned. No application role, including a shared table-owner
-- login, may manufacture, rewrite or delete a denial. Migrator replays are ledger no-ops; explicit
-- backfill replay is handled by the admission withholding trigger. Foreign-key cascades remain
-- available for normal cleanup.
CREATE OR REPLACE FUNCTION app.legacy_audience_quarantine_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  row_json jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    row_json := to_jsonb(NEW);
    IF EXISTS (
      SELECT 1 FROM app.legacy_audience_quarantine q
      WHERE q.workspace_id = (row_json ->> 'workspace_id')::uuid
        AND q.channel_id = (row_json ->> 'channel_id')::uuid
        AND q.principal_kind = (row_json ->> 'principal_kind')::app.conversation_principal_kind
        AND q.principal_id = (row_json ->> 'principal_id')::uuid
    ) THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'legacy audience quarantine is migration-managed'
    USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_audience_quarantine_guard ON app.legacy_audience_quarantine;
CREATE TRIGGER legacy_audience_quarantine_guard BEFORE INSERT OR UPDATE OR DELETE ON app.legacy_audience_quarantine
  FOR EACH ROW EXECUTE FUNCTION app.legacy_audience_quarantine_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.legacy_audience_quarantine_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'legacy audience quarantine is migration-managed'
    USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_audience_quarantine_no_truncate ON app.legacy_audience_quarantine;
CREATE TRIGGER legacy_audience_quarantine_no_truncate BEFORE TRUNCATE ON app.legacy_audience_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION app.legacy_audience_quarantine_no_truncate();
