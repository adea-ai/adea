CREATE TYPE "app"."task_execution_attempt_change" AS ENUM('initial', 'sticky_retry', 'authorized_reroute');--> statement-breakpoint
CREATE TYPE "app"."task_execution_location_kind" AS ENUM('local_device', 'remote_host', 'agent_hq_cloud');--> statement-breakpoint
CREATE TABLE "app"."task_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"location_kind" "app"."task_execution_location_kind" NOT NULL,
	"runtime_node_id" uuid,
	"change" "app"."task_execution_attempt_change" DEFAULT 'initial' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_execution_attempts_task_attempt_unique" UNIQUE("task_id","attempt"),
	CONSTRAINT "task_execution_attempts_attempt_positive" CHECK ("app"."task_execution_attempts"."attempt" > 0),
	CONSTRAINT "task_execution_attempts_node_matches_location" CHECK (("app"."task_execution_attempts"."location_kind" = 'agent_hq_cloud' and "app"."task_execution_attempts"."runtime_node_id" is null) or ("app"."task_execution_attempts"."location_kind" <> 'agent_hq_cloud' and "app"."task_execution_attempts"."runtime_node_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."task_execution_attempts" ADD CONSTRAINT "task_execution_attempts_runtime_node_id_runtime_nodes_id_fk" FOREIGN KEY ("runtime_node_id") REFERENCES "app"."runtime_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_execution_attempts_task_idx" ON "app"."task_execution_attempts" USING btree ("workspace_id","task_id","attempt");