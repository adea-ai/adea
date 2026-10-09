CREATE TABLE "app"."artifact_reference_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" text NOT NULL,
	"source_workspace_id" uuid NOT NULL,
	"audience_workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"expires_at" text,
	"revision" integer NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_reference_grants_grant_id_unique" UNIQUE("grant_id"),
	CONSTRAINT "artifact_reference_grants_revision_positive" CHECK ("app"."artifact_reference_grants"."revision" > 0),
	CONSTRAINT "artifact_reference_grants_version_positive" CHECK ("app"."artifact_reference_grants"."version" > 0),
	CONSTRAINT "artifact_reference_grants_checksum_sha256" CHECK ("app"."artifact_reference_grants"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifact_reference_grants_grant_id_nonempty" CHECK (length(btrim("app"."artifact_reference_grants"."grant_id")) > 0),
	CONSTRAINT "artifact_reference_grants_workspaces_distinct" CHECK ("app"."artifact_reference_grants"."source_workspace_id" <> "app"."artifact_reference_grants"."audience_workspace_id")
);
--> statement-breakpoint
ALTER TABLE "app"."artifact_reference_grants" ADD CONSTRAINT "artifact_reference_grants_source_workspace_fk" FOREIGN KEY ("source_workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."artifact_reference_grants" ADD CONSTRAINT "artifact_reference_grants_audience_workspace_fk" FOREIGN KEY ("audience_workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_reference_grants_source_artifact_idx" ON "app"."artifact_reference_grants" USING btree ("source_workspace_id","artifact_id","audience_workspace_id");