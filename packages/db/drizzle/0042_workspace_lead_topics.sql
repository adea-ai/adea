DROP INDEX "app"."channels_active_direct_agent_unique";--> statement-breakpoint
ALTER TABLE "app"."agents" ADD COLUMN "is_workspace_lead" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."channels" ADD COLUMN "create_payload_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_lead_unique" ON "app"."agents" USING btree ("workspace_id") WHERE "app"."agents"."is_workspace_lead" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_active_default_direct_agent_unique" ON "app"."channels" USING btree ("workspace_id","agent_id") WHERE "app"."channels"."kind" = 'direct_agent' and "app"."channels"."lifecycle_state" = 'active' and "app"."channels"."idempotency_key" like 'direct-agent:%';--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_workspace_lead_standalone" CHECK ("app"."agents"."is_workspace_lead" = false or ("app"."agents"."project_id" is null and "app"."agents"."lifecycle_state" <> 'archived'));
