-- Expand the opaque identifier generator before adding the node reference.
-- A volatile default backfills existing nodes and preserves older insert paths.
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
  IF prefix NOT IN ('wsp', 'prj', 'rnr', 'tsk', 'agt') THEN
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
ALTER TABLE "app"."runtime_nodes" ADD COLUMN "control_plane_runtime_node_ref_id" text DEFAULT app.control_plane_identifier('rnr') NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_nodes_control_plane_ref_uidx" ON "app"."runtime_nodes" USING btree ("control_plane_runtime_node_ref_id");--> statement-breakpoint
ALTER TABLE "app"."runtime_nodes" ADD CONSTRAINT "runtime_nodes_control_plane_ref_valid" CHECK ("app"."runtime_nodes"."control_plane_runtime_node_ref_id" ~ '^rnr_[0-9A-HJKMNP-TV-Z]{26}$');