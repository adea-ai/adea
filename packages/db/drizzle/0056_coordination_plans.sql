CREATE TABLE "app"."coordination_plan_citations" (
	"plan_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"position" smallint NOT NULL,
	"job_id" uuid NOT NULL,
	CONSTRAINT "coordination_plan_citations_pk" PRIMARY KEY("plan_id","revision","position"),
	CONSTRAINT "coordination_plan_citations_job_unique" UNIQUE("plan_id","revision","job_id"),
	CONSTRAINT "coordination_plan_citations_position_valid" CHECK ("app"."coordination_plan_citations"."position" between 0 and 49)
);
--> statement-breakpoint
CREATE TABLE "app"."coordination_plan_revisions" (
	"plan_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"citation_count" smallint NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coordination_plan_revisions_pk" PRIMARY KEY("plan_id","revision"),
	CONSTRAINT "coordination_plan_revisions_revision_valid" CHECK ("app"."coordination_plan_revisions"."revision" >= 1),
	CONSTRAINT "coordination_plan_revisions_count_valid" CHECK ("app"."coordination_plan_revisions"."citation_count" between 0 and 50)
);
--> statement-breakpoint
CREATE TABLE "app"."coordination_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"create_payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coordination_plans_idempotency_unique" UNIQUE("workspace_id","channel_id","idempotency_key"),
	CONSTRAINT "coordination_plans_scope_unique" UNIQUE("id","workspace_id","channel_id"),
	CONSTRAINT "coordination_plans_revision_valid" CHECK ("app"."coordination_plans"."current_revision" between 1 and 2147483647),
	CONSTRAINT "coordination_plans_idempotency_valid" CHECK (length("app"."coordination_plans"."idempotency_key") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "app"."coordination_plan_citations" ADD CONSTRAINT "coordination_plan_citations_revision_fk" FOREIGN KEY ("plan_id","revision") REFERENCES "app"."coordination_plan_revisions"("plan_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."coordination_plan_revisions" ADD CONSTRAINT "coordination_plan_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."coordination_plan_revisions" ADD CONSTRAINT "coordination_plan_revisions_plan_scope_fk" FOREIGN KEY ("plan_id","workspace_id","channel_id") REFERENCES "app"."coordination_plans"("id","workspace_id","channel_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."coordination_plans" ADD CONSTRAINT "coordination_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."coordination_plans" ADD CONSTRAINT "coordination_plans_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."coordination_plans" ADD CONSTRAINT "coordination_plans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coordination_plans_channel_idx" ON "app"."coordination_plans" USING btree ("workspace_id","channel_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."coordination_plan_history_immutable"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'accepted coordination plan revisions are immutable'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'coordination_plan_history_immutable';
END
$$;--> statement-breakpoint
CREATE TRIGGER "coordination_plan_revisions_immutable"
  BEFORE UPDATE OR DELETE ON "app"."coordination_plan_revisions"
  FOR EACH ROW EXECUTE FUNCTION "app"."coordination_plan_history_immutable"();--> statement-breakpoint
CREATE TRIGGER "coordination_plan_citations_immutable"
  BEFORE UPDATE OR DELETE ON "app"."coordination_plan_citations"
  FOR EACH ROW EXECUTE FUNCTION "app"."coordination_plan_history_immutable"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."coordination_plans_identity_immutable"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."channel_id" IS DISTINCT FROM OLD."channel_id"
    OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."create_payload_hash" IS DISTINCT FROM OLD."create_payload_hash"
    OR NEW."current_revision" <> OLD."current_revision" + 1
    OR NEW."current_revision" < OLD."current_revision"
  THEN
    RAISE EXCEPTION 'coordination plan identity is immutable and revisions advance by one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'coordination_plans_identity_immutable';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "coordination_plans_identity_immutable"
  BEFORE UPDATE ON "app"."coordination_plans"
  FOR EACH ROW EXECUTE FUNCTION "app"."coordination_plans_identity_immutable"();--> statement-breakpoint
CREATE TRIGGER "coordination_plans_no_delete"
  BEFORE DELETE ON "app"."coordination_plans"
  FOR EACH ROW EXECUTE FUNCTION "app"."coordination_plan_history_immutable"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."coordination_plan_citation_sealed"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  declared smallint;
BEGIN
  SELECT r."citation_count" INTO declared
    FROM "app"."coordination_plan_revisions" r
    WHERE r."plan_id" = NEW."plan_id" AND r."revision" = NEW."revision";
  IF declared IS NULL OR NEW."position" >= declared THEN
    RAISE EXCEPTION 'a coordination plan revision cannot take a citation beyond its declared count'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'coordination_plan_citation_sealed';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "coordination_plan_citations_sealed"
  BEFORE INSERT ON "app"."coordination_plan_citations"
  FOR EACH ROW EXECUTE FUNCTION "app"."coordination_plan_citation_sealed"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."coordination_plan_revision_complete"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (SELECT count(*) FROM "app"."coordination_plan_citations" c
        WHERE c."plan_id" = NEW."plan_id" AND c."revision" = NEW."revision") <> NEW."citation_count" THEN
    RAISE EXCEPTION 'a coordination plan revision must hold exactly its declared citations'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'coordination_plan_revision_complete';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "coordination_plan_revisions_complete"
  AFTER INSERT ON "app"."coordination_plan_revisions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "app"."coordination_plan_revision_complete"();
