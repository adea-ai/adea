-- Parent scoped uniqueness precedes composite foreign keys. This migration
-- is expand-only except for widening outbox idempotency to workspace scope.
CREATE TYPE "app"."task_submission_state" AS ENUM('pending_delivery', 'queued_for_node');--> statement-breakpoint
CREATE TABLE "app"."task_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"runtime_node_id" uuid NOT NULL,
	"location_kind" "app"."runtime_node_kind" NOT NULL,
	"state" "app"."task_submission_state" NOT NULL,
	"task_version" integer NOT NULL,
	"profile_id" text NOT NULL,
	"profile_version" text NOT NULL,
	"profile_revision" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_submissions_task_unique" UNIQUE("task_id"),
	CONSTRAINT "task_submissions_workspace_idempotency_unique" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "task_submissions_workspace_request_unique" UNIQUE("workspace_id","request_id"),
	CONSTRAINT "task_submissions_command_unique" UNIQUE("command_id"),
	CONSTRAINT "task_submissions_version_valid" CHECK ("app"."task_submissions"."task_version" > 0 and "app"."task_submissions"."profile_revision" >= 0),
	CONSTRAINT "task_submissions_hash_valid" CHECK ("app"."task_submissions"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "task_submissions_idempotency_bounded" CHECK (char_length("app"."task_submissions"."idempotency_key") between 1 and 128),
	CONSTRAINT "task_submissions_profile_valid" CHECK ("app"."task_submissions"."profile_id" ~ '^prf_[0-9A-HJKMNP-TV-Z]{26}$' and "app"."task_submissions"."profile_version" ~ '^pfv_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
DROP INDEX "app"."command_outbox_idempotency_uidx";--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "control_plane_agent_id" text DEFAULT app.control_plane_identifier('agt') NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "control_plane_task_id" text DEFAULT app.control_plane_identifier('tsk') NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "command_outbox_workspace_id_uidx" ON "app"."command_outbox" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_nodes_workspace_id_uidx" ON "app"."runtime_nodes" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "command_outbox_idempotency_uidx" ON "app"."command_outbox" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_workspace_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_workspace_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "app"."task_submissions" ADD CONSTRAINT "task_submissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_submissions" ADD CONSTRAINT "task_submissions_task_scope_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "app"."tasks"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_submissions" ADD CONSTRAINT "task_submissions_agent_scope_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "app"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_submissions" ADD CONSTRAINT "task_submissions_node_scope_fk" FOREIGN KEY ("workspace_id","runtime_node_id") REFERENCES "app"."runtime_nodes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_submissions" ADD CONSTRAINT "task_submissions_command_scope_fk" FOREIGN KEY ("workspace_id","command_id") REFERENCES "app"."command_outbox"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_submissions_node_pending_idx" ON "app"."task_submissions" USING btree ("workspace_id","runtime_node_id","state","created_at");--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_control_plane_id_unique" UNIQUE("control_plane_agent_id");--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_control_plane_id_unique" UNIQUE("control_plane_task_id");--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_control_plane_id_valid" CHECK ("app"."agents"."control_plane_agent_id" ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$');--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_control_plane_id_valid" CHECK ("app"."tasks"."control_plane_task_id" ~ '^tsk_[0-9A-HJKMNP-TV-Z]{26}$');