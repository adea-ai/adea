CREATE TYPE "app"."channel_kind" AS ENUM('room', 'direct_agent', 'group');--> statement-breakpoint
CREATE TYPE "app"."channel_lifecycle_state" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "app"."channel_visibility" AS ENUM('workspace', 'participants');--> statement-breakpoint
CREATE TYPE "app"."conversation_principal_kind" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "app"."message_sender_kind" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TABLE "app"."channel_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"principal_kind" "app"."conversation_principal_kind" NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_participants_principal_consistent" CHECK (("app"."channel_participants"."principal_kind" = 'user' and "app"."channel_participants"."user_id" is not null and "app"."channel_participants"."agent_id" is null) or ("app"."channel_participants"."principal_kind" = 'agent' and "app"."channel_participants"."user_id" is null and "app"."channel_participants"."agent_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "app"."channel_kind" NOT NULL,
	"room_id" uuid,
	"agent_id" uuid,
	"task_id" uuid,
	"title" text NOT NULL,
	"visibility" "app"."channel_visibility" DEFAULT 'workspace' NOT NULL,
	"is_primary_room_channel" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"lifecycle_state" "app"."channel_lifecycle_state" DEFAULT 'active' NOT NULL,
	"idempotency_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_workspace_idempotency_unique" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "channels_title_nonempty" CHECK (length(btrim("app"."channels"."title")) > 0),
	CONSTRAINT "channels_idempotency_nonempty" CHECK (length(btrim("app"."channels"."idempotency_key")) > 0),
	CONSTRAINT "channels_sort_nonnegative" CHECK ("app"."channels"."sort_order" >= 0),
	CONSTRAINT "channels_version_positive" CHECK ("app"."channels"."version" > 0),
	CONSTRAINT "channels_kind_association" CHECK (("app"."channels"."kind" = 'room' and "app"."channels"."room_id" is not null and "app"."channels"."agent_id" is null) or ("app"."channels"."kind" = 'direct_agent' and "app"."channels"."room_id" is null and "app"."channels"."agent_id" is not null) or ("app"."channels"."kind" = 'group' and "app"."channels"."room_id" is null and "app"."channels"."agent_id" is null)),
	CONSTRAINT "channels_primary_room_only" CHECK ("app"."channels"."is_primary_room_channel" = false or ("app"."channels"."kind" = 'room' and "app"."channels"."room_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."message_artifact_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_artifact_references_unique" UNIQUE("message_id","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "app"."message_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"principal_kind" "app"."conversation_principal_kind" NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_mentions_principal_consistent" CHECK (("app"."message_mentions"."principal_kind" = 'user' and "app"."message_mentions"."user_id" is not null and "app"."message_mentions"."agent_id" is null) or ("app"."message_mentions"."principal_kind" = 'agent' and "app"."message_mentions"."user_id" is null and "app"."message_mentions"."agent_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."messages_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"sender_kind" "app"."message_sender_kind" NOT NULL,
	"sender_user_id" uuid,
	"sender_agent_id" uuid,
	"sender_system_id" text,
	"body_text" text,
	"body_content_ref_id" uuid,
	"thread_root_message_id" uuid,
	"reply_to_message_id" uuid,
	"task_id" uuid,
	"execution_ref" text,
	"external_session_ref" text,
	"idempotency_key" text NOT NULL,
	"create_payload_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_channel_idempotency_unique" UNIQUE("channel_id","idempotency_key"),
	CONSTRAINT "messages_idempotency_nonempty" CHECK (length(btrim("app"."messages"."idempotency_key")) > 0),
	CONSTRAINT "messages_version_positive" CHECK ("app"."messages"."version" > 0),
	CONSTRAINT "messages_sender_consistent" CHECK (("app"."messages"."sender_kind" = 'user' and "app"."messages"."sender_user_id" is not null and "app"."messages"."sender_agent_id" is null and "app"."messages"."sender_system_id" is null) or ("app"."messages"."sender_kind" = 'agent' and "app"."messages"."sender_user_id" is null and "app"."messages"."sender_agent_id" is not null and "app"."messages"."sender_system_id" is null) or ("app"."messages"."sender_kind" = 'system' and "app"."messages"."sender_user_id" is null and "app"."messages"."sender_agent_id" is null and length(btrim("app"."messages"."sender_system_id")) > 0)),
	CONSTRAINT "messages_body_available_or_deleted" CHECK ("app"."messages"."deleted_at" is not null or "app"."messages"."body_text" is not null or "app"."messages"."body_content_ref_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."channel_participants" ADD CONSTRAINT "channel_participants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_participants" ADD CONSTRAINT "channel_participants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_participants" ADD CONSTRAINT "channel_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_participants" ADD CONSTRAINT "channel_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channels" ADD CONSTRAINT "channels_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "app"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channels" ADD CONSTRAINT "channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channels" ADD CONSTRAINT "channels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_artifact_references" ADD CONSTRAINT "message_artifact_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_artifact_references" ADD CONSTRAINT "message_artifact_references_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_mentions" ADD CONSTRAINT "message_mentions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_mentions" ADD CONSTRAINT "message_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_mentions" ADD CONSTRAINT "message_mentions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "app"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_thread_root_message_id_messages_id_fk" FOREIGN KEY ("thread_root_message_id") REFERENCES "app"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "app"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_participants_user_unique" ON "app"."channel_participants" USING btree ("channel_id","user_id") WHERE "app"."channel_participants"."principal_kind" = 'user' and "app"."channel_participants"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_participants_agent_unique" ON "app"."channel_participants" USING btree ("channel_id","agent_id") WHERE "app"."channel_participants"."principal_kind" = 'agent' and "app"."channel_participants"."agent_id" is not null;--> statement-breakpoint
CREATE INDEX "channel_participants_workspace_idx" ON "app"."channel_participants" USING btree ("workspace_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_active_primary_room_unique" ON "app"."channels" USING btree ("room_id") WHERE "app"."channels"."is_primary_room_channel" = true and "app"."channels"."lifecycle_state" = 'active' and "app"."channels"."room_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_active_direct_agent_unique" ON "app"."channels" USING btree ("workspace_id","agent_id") WHERE "app"."channels"."kind" = 'direct_agent' and "app"."channels"."lifecycle_state" = 'active';--> statement-breakpoint
CREATE INDEX "channels_workspace_order_idx" ON "app"."channels" USING btree ("workspace_id","lifecycle_state","sort_order","id");--> statement-breakpoint
CREATE INDEX "channels_room_idx" ON "app"."channels" USING btree ("workspace_id","room_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "message_artifact_workspace_idx" ON "app"."message_artifact_references" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_mentions_user_unique" ON "app"."message_mentions" USING btree ("message_id","user_id") WHERE "app"."message_mentions"."principal_kind" = 'user' and "app"."message_mentions"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_mentions_agent_unique" ON "app"."message_mentions" USING btree ("message_id","agent_id") WHERE "app"."message_mentions"."principal_kind" = 'agent' and "app"."message_mentions"."agent_id" is not null;--> statement-breakpoint
CREATE INDEX "message_mentions_workspace_idx" ON "app"."message_mentions" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sequence_unique" ON "app"."messages" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "messages_channel_order_idx" ON "app"."messages" USING btree ("channel_id","sequence");--> statement-breakpoint
CREATE INDEX "messages_workspace_thread_idx" ON "app"."messages" USING btree ("workspace_id","channel_id","thread_root_message_id","sequence");--> statement-breakpoint
CREATE INDEX "messages_task_idx" ON "app"."messages" USING btree ("workspace_id","task_id");
--> statement-breakpoint
INSERT INTO "app"."channels" (
	"workspace_id",
	"kind",
	"room_id",
	"title",
	"visibility",
	"is_primary_room_channel",
	"sort_order",
	"lifecycle_state",
	"idempotency_key"
)
SELECT
	"workspace_id",
	'room'::"app"."channel_kind",
	"id",
	"name",
	'workspace'::"app"."channel_visibility",
	true,
	"sort_order",
	'active'::"app"."channel_lifecycle_state",
	'primary-room:' || "id"::text
FROM "app"."rooms"
WHERE "lifecycle_state" = 'active';
