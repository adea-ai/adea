ALTER TABLE "app"."lead_turn_intents" ADD COLUMN "rollback_fenced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD COLUMN "rollback_fence_actor_kind" text;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD COLUMN "rollback_fence_actor_ref" text;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD COLUMN "rollback_fence_reason" text;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD COLUMN "rollback_fence_authority" jsonb;--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_rollback_fence_complete" CHECK (("app"."lead_turn_intents"."rollback_fenced_at" is null and "app"."lead_turn_intents"."rollback_fence_actor_kind" is null and "app"."lead_turn_intents"."rollback_fence_actor_ref" is null and "app"."lead_turn_intents"."rollback_fence_reason" is null and "app"."lead_turn_intents"."rollback_fence_authority" is null) or ("app"."lead_turn_intents"."rollback_fenced_at" is not null and "app"."lead_turn_intents"."rollback_fence_actor_kind" is not null and "app"."lead_turn_intents"."rollback_fence_actor_ref" is not null and "app"."lead_turn_intents"."rollback_fence_reason" is not null and "app"."lead_turn_intents"."rollback_fence_authority" is not null));--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_rollback_fence_actor_valid" CHECK ("app"."lead_turn_intents"."rollback_fence_actor_kind" is null or ("app"."lead_turn_intents"."rollback_fence_actor_kind" = 'user' and "app"."lead_turn_intents"."rollback_fence_actor_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') or ("app"."lead_turn_intents"."rollback_fence_actor_kind" = 'operator' and "app"."lead_turn_intents"."rollback_fence_actor_ref" ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'));--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_rollback_fence_reason_valid" CHECK ("app"."lead_turn_intents"."rollback_fence_reason" is null or "app"."lead_turn_intents"."rollback_fence_reason" in ('operator_intervention', 'rollback_cohort'));--> statement-breakpoint
ALTER TABLE "app"."lead_turn_intents" ADD CONSTRAINT "lead_turn_intents_rollback_fence_authority_valid" CHECK ("app"."lead_turn_intents"."rollback_fence_authority" is null or (jsonb_typeof("app"."lead_turn_intents"."rollback_fence_authority") = 'object' and ("app"."lead_turn_intents"."rollback_fence_authority"->>'schemaVersion') is not distinct from '1'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."lead_turn_intents_rollback_fence_immutable"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD."rollback_fenced_at" IS NOT NULL AND (
    NEW."rollback_fenced_at" IS DISTINCT FROM OLD."rollback_fenced_at"
    OR NEW."rollback_fence_actor_kind" IS DISTINCT FROM OLD."rollback_fence_actor_kind"
    OR NEW."rollback_fence_actor_ref" IS DISTINCT FROM OLD."rollback_fence_actor_ref"
    OR NEW."rollback_fence_reason" IS DISTINCT FROM OLD."rollback_fence_reason"
    OR NEW."rollback_fence_authority" IS DISTINCT FROM OLD."rollback_fence_authority"
  ) THEN
    RAISE EXCEPTION 'lead turn rollback fence attribution is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'lead_turn_intents_rollback_fence_immutable';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "lead_turn_intents_rollback_fence_immutable"
  BEFORE UPDATE ON "app"."lead_turn_intents"
  FOR EACH ROW EXECUTE FUNCTION "app"."lead_turn_intents_rollback_fence_immutable"();
