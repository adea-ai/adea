CREATE TABLE "app"."runtime_node_delivery_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"runtime_node_id" uuid NOT NULL,
	"signing_key_id" uuid NOT NULL,
	"nonce" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."task_submissions" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
-- Recover only unambiguous recorded submission authority; never substitute the current owner.
UPDATE "app"."task_submissions" AS submission
SET "actor_user_id" = audit.user_id
FROM (
  SELECT intent.id, min(actor.id::text)::uuid AS user_id
  FROM "app"."task_submissions" AS intent
  JOIN "app"."workspace_events" AS event
    ON event.workspace_id = intent.workspace_id
    AND event.event_type = 'task.submission_queued'
    AND event.payload ->> 'submissionId' = intent.id::text
  JOIN "app"."users" AS actor ON actor.id::text = event.payload ->> 'actorUserId'
  GROUP BY intent.id HAVING count(DISTINCT actor.id) = 1
) AS audit WHERE submission.id = audit.id;
--> statement-breakpoint
ALTER TABLE "app"."runtime_node_delivery_requests" ADD CONSTRAINT "runtime_node_delivery_requests_signing_key_id_runtime_node_keys_id_fk" FOREIGN KEY ("signing_key_id") REFERENCES "app"."runtime_node_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_node_delivery_requests" ADD CONSTRAINT "runtime_node_delivery_requests_scope_fk" FOREIGN KEY ("workspace_id","runtime_node_id") REFERENCES "app"."runtime_nodes"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_node_delivery_requests_nonce_uidx" ON "app"."runtime_node_delivery_requests" USING btree ("runtime_node_id","nonce");--> statement-breakpoint
CREATE INDEX "runtime_node_delivery_requests_rate_idx" ON "app"."runtime_node_delivery_requests" USING btree ("runtime_node_id","created_at");--> statement-breakpoint
CREATE INDEX "runtime_node_delivery_requests_expiry_idx" ON "app"."runtime_node_delivery_requests" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "app"."task_submissions" ADD CONSTRAINT "task_submissions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;
