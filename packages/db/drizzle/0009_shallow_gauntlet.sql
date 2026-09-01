CREATE TYPE "app"."task_lifecycle_state" AS ENUM('created', 'queued', 'cancelled', 'archived');--> statement-breakpoint
CREATE TYPE "app"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TABLE "app"."task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_pair_unique" UNIQUE("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependencies_not_self" CHECK ("app"."task_dependencies"."task_id" <> "app"."task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "app"."task_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_id" uuid NOT NULL,
	"correlation_id" text,
	"command_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"resulting_version" integer,
	"result_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_mutations_workspace_idempotency_unique" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "task_mutations_idempotency_nonempty" CHECK (length(btrim("app"."task_mutations"."idempotency_key")) > 0),
	CONSTRAINT "task_mutations_command_nonempty" CHECK (length(btrim("app"."task_mutations"."command_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"creator_user_id" uuid NOT NULL,
	"agent_id" uuid,
	"room_id" uuid,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"lifecycle_state" "app"."task_lifecycle_state" DEFAULT 'created' NOT NULL,
	"priority" "app"."task_priority" DEFAULT 'normal' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"artifact_refs" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"channel_id" uuid,
	"message_id" uuid,
	"thread_root_message_id" uuid,
	"control_plane_execution_ref" text,
	"control_plane_workflow_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_title_nonempty" CHECK (length(btrim("app"."tasks"."title")) > 0),
	CONSTRAINT "tasks_objective_nonempty" CHECK (length(btrim("app"."tasks"."objective")) > 0),
	CONSTRAINT "tasks_version_positive" CHECK ("app"."tasks"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "app"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_mutations" ADD CONSTRAINT "task_mutations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_mutations" ADD CONSTRAINT "task_mutations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD CONSTRAINT "tasks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "app"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_dependencies_workspace_idx" ON "app"."task_dependencies" USING btree ("workspace_id","task_id");--> statement-breakpoint
CREATE INDEX "task_dependents_workspace_idx" ON "app"."task_dependencies" USING btree ("workspace_id","depends_on_task_id");--> statement-breakpoint
CREATE INDEX "task_mutations_task_idx" ON "app"."task_mutations" USING btree ("workspace_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_mutations_request_idx" ON "app"."task_mutations" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "tasks_workspace_lifecycle_idx" ON "app"."tasks" USING btree ("workspace_id","lifecycle_state","priority","created_at");--> statement-breakpoint
CREATE INDEX "tasks_workspace_agent_idx" ON "app"."tasks" USING btree ("workspace_id","agent_id");--> statement-breakpoint
CREATE INDEX "tasks_workspace_room_idx" ON "app"."tasks" USING btree ("workspace_id","room_id");--> statement-breakpoint
CREATE INDEX "tasks_conversation_idx" ON "app"."tasks" USING btree ("workspace_id","channel_id","message_id");