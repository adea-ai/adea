CREATE TYPE "app"."channel_archive_source" AS ENUM('individual', 'project_cascade');--> statement-breakpoint
CREATE TYPE "app"."management_authority_consumption_state" AS ENUM('claimed', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "app"."management_authority_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"authority_ref" text NOT NULL,
	"authority_revision" integer NOT NULL,
	"operation" text NOT NULL,
	"target_id" text,
	"action_digest" text NOT NULL,
	"input_digest" text NOT NULL,
	"target_digest" text NOT NULL,
	"state" "app"."management_authority_consumption_state" DEFAULT 'claimed' NOT NULL,
	"result_digest" text,
	"failure_code" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "management_authority_consumptions_decision_unique" UNIQUE("decision_id"),
	CONSTRAINT "management_authority_consumptions_decision_bounded" CHECK (length(btrim("app"."management_authority_consumptions"."decision_id")) between 1 and 128),
	CONSTRAINT "management_authority_consumptions_authority_bounded" CHECK (length(btrim("app"."management_authority_consumptions"."authority_ref")) between 1 and 128),
	CONSTRAINT "management_authority_consumptions_operation_bounded" CHECK (length(btrim("app"."management_authority_consumptions"."operation")) between 1 and 128),
	CONSTRAINT "management_authority_consumptions_target_bounded" CHECK ("app"."management_authority_consumptions"."target_id" is null or length("app"."management_authority_consumptions"."target_id") between 1 and 128),
	CONSTRAINT "management_authority_consumptions_revision_positive" CHECK ("app"."management_authority_consumptions"."authority_revision" > 0),
	CONSTRAINT "management_authority_consumptions_digests_valid" CHECK ("app"."management_authority_consumptions"."action_digest" ~ '^sha256:[a-f0-9]{64}$'
        and "app"."management_authority_consumptions"."input_digest" ~ '^sha256:[a-f0-9]{64}$'
        and "app"."management_authority_consumptions"."target_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "management_authority_consumptions_state_fields" CHECK (("app"."management_authority_consumptions"."state" = 'claimed'
          and "app"."management_authority_consumptions"."completed_at" is null
          and "app"."management_authority_consumptions"."result_digest" is null
          and "app"."management_authority_consumptions"."failure_code" is null)
        or ("app"."management_authority_consumptions"."state" = 'succeeded'
          and "app"."management_authority_consumptions"."completed_at" is not null
          and "app"."management_authority_consumptions"."failure_code" is null)
        or ("app"."management_authority_consumptions"."state" = 'failed'
          and "app"."management_authority_consumptions"."completed_at" is not null
          and "app"."management_authority_consumptions"."result_digest" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."channels" ADD COLUMN "archive_source" "app"."channel_archive_source" DEFAULT 'individual' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."management_authority_consumptions" ADD CONSTRAINT "management_authority_consumptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "management_authority_consumptions_workspace_idx" ON "app"."management_authority_consumptions" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_version_positive" CHECK ("app"."projects"."version" > 0);