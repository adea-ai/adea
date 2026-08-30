CREATE TABLE "app"."channel_read_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"last_read_sequence" bigint DEFAULT 0 NOT NULL,
	"manually_unread" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_read_states_user_channel_unique" UNIQUE("workspace_id","user_id","channel_id"),
	CONSTRAINT "channel_read_states_sequence_nonnegative" CHECK ("app"."channel_read_states"."last_read_sequence" >= 0),
	CONSTRAINT "channel_read_states_version_positive" CHECK ("app"."channel_read_states"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."thread_read_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_root_message_id" uuid NOT NULL,
	"last_read_sequence" bigint DEFAULT 0 NOT NULL,
	"manually_unread" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_read_states_user_thread_unique" UNIQUE("workspace_id","user_id","thread_root_message_id"),
	CONSTRAINT "thread_read_states_sequence_nonnegative" CHECK ("app"."thread_read_states"."last_read_sequence" >= 0),
	CONSTRAINT "thread_read_states_version_positive" CHECK ("app"."thread_read_states"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."channel_read_states" ADD CONSTRAINT "channel_read_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_read_states" ADD CONSTRAINT "channel_read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."channel_read_states" ADD CONSTRAINT "channel_read_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."thread_read_states" ADD CONSTRAINT "thread_read_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."thread_read_states" ADD CONSTRAINT "thread_read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."thread_read_states" ADD CONSTRAINT "thread_read_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."thread_read_states" ADD CONSTRAINT "thread_read_states_thread_root_message_id_messages_id_fk" FOREIGN KEY ("thread_root_message_id") REFERENCES "app"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_read_states_workspace_user_idx" ON "app"."channel_read_states" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "thread_read_states_workspace_user_channel_idx" ON "app"."thread_read_states" USING btree ("workspace_id","user_id","channel_id");