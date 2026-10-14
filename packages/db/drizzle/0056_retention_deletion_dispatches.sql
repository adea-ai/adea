CREATE TABLE "app"."retention_deletion_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"category" "app"."retention_category" NOT NULL,
	"subject_id" text NOT NULL,
	"coverage" "app"."retention_cleanup_coverage" NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_deletion_dispatches_subject_bounded" CHECK (char_length("app"."retention_deletion_dispatches"."subject_id") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "app"."retention_deletion_dispatches" ADD CONSTRAINT "retention_deletion_dispatches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retention_deletion_dispatches" ADD CONSTRAINT "retention_deletion_dispatches_authorization_fk" FOREIGN KEY ("authorization_id") REFERENCES "app"."retention_deletion_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retention_deletion_dispatches_generation_uidx" ON "app"."retention_deletion_dispatches" USING btree ("authorization_id","coverage");--> statement-breakpoint
CREATE INDEX "retention_deletion_dispatches_subject_idx" ON "app"."retention_deletion_dispatches" USING btree ("workspace_id","category","subject_id");