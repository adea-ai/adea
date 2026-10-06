-- ADR 0013: Control Plane scope identifiers. Adea mints a prefixed ULID per
-- workspace and project (`wsp_`/`prj_` + 26 Crockford base32 characters: a
-- 48-bit millisecond timestamp, then 80 random bits from gen_random_uuid()).
-- The application mints its own on create; this function is the column
-- default so the ADD COLUMN below backfills every existing row with a fresh
-- value (a volatile default is evaluated per row) and so a Worker that
-- predates the column keeps inserting during the expand-only rollout.
CREATE OR REPLACE FUNCTION "app"."control_plane_identifier"(prefix text) RETURNS text
LANGUAGE plpgsql VOLATILE PARALLEL SAFE SET search_path = pg_catalog AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  milliseconds bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  random_bytes bytea := substring(uuid_send(gen_random_uuid()) from 1 for 6)
    || substring(uuid_send(gen_random_uuid()) from 10 for 7);
  random_bits bit(104) := ('x' || encode(random_bytes, 'hex'))::bit(104);
  result text := '';
BEGIN
  IF prefix NOT IN ('wsp', 'prj', 'tsk', 'agt') THEN
    RAISE EXCEPTION 'invalid Control Plane identifier prefix';
  END IF;
  FOR i IN REVERSE 9..0 LOOP
    result := result || substr(alphabet, ((milliseconds >> (i * 5)) & 31)::int + 1, 1);
  END LOOP;
  FOR i IN 0..15 LOOP
    result := result || substr(alphabet, substring(random_bits from i * 5 + 1 for 5)::int + 1, 1);
  END LOOP;
  RETURN prefix || '_' || result;
END
$$;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD COLUMN "control_plane_project_id" text DEFAULT app.control_plane_identifier('prj') NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "control_plane_workspace_id" text DEFAULT app.control_plane_identifier('wsp') NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_control_plane_project_id_unique" UNIQUE("control_plane_project_id");--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_control_plane_workspace_id_unique" UNIQUE("control_plane_workspace_id");--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_control_plane_project_id_valid" CHECK ("app"."projects"."control_plane_project_id" ~ '^prj_[0-9A-HJKMNP-TV-Z]{26}$');--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_control_plane_workspace_id_valid" CHECK ("app"."workspaces"."control_plane_workspace_id" ~ '^wsp_[0-9A-HJKMNP-TV-Z]{26}$');