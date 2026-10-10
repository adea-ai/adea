CREATE TABLE "app"."group_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"principal_kind" "app"."conversation_principal_kind" NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"joined_sequence" bigint NOT NULL,
	"joined_at" text NOT NULL,
	"auth_group_id" text NOT NULL,
	"auth_grant_id" text NOT NULL,
	"auth_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_admissions_principal_consistent" CHECK (("app"."group_admissions"."principal_kind" = 'user' and "app"."group_admissions"."user_id" is not null and "app"."group_admissions"."agent_id" is null) or ("app"."group_admissions"."principal_kind" = 'agent' and "app"."group_admissions"."user_id" is null and "app"."group_admissions"."agent_id" is not null)),
	CONSTRAINT "group_admissions_join_nonnegative" CHECK ("app"."group_admissions"."joined_sequence" >= 0),
	CONSTRAINT "group_admissions_joined_nonempty" CHECK (length(btrim("app"."group_admissions"."joined_at")) > 0),
	CONSTRAINT "group_admissions_auth_group_nonempty" CHECK (length(btrim("app"."group_admissions"."auth_group_id")) > 0),
	CONSTRAINT "group_admissions_auth_grant_nonempty" CHECK (length(btrim("app"."group_admissions"."auth_grant_id")) > 0),
	CONSTRAINT "group_admissions_auth_revision_positive" CHECK ("app"."group_admissions"."auth_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."group_audience_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"grant_id" text NOT NULL,
	"revision" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"issued_at" text NOT NULL,
	"expires_at" text,
	"revoked_at" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_audience_grants_grant_id_nonempty" CHECK (length(btrim("app"."group_audience_grants"."grant_id")) > 0),
	CONSTRAINT "group_audience_grants_revision_positive" CHECK ("app"."group_audience_grants"."revision" > 0),
	CONSTRAINT "group_audience_grants_issued_nonempty" CHECK (length(btrim("app"."group_audience_grants"."issued_at")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."group_enlistment_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"grant_id" text NOT NULL,
	"revision" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"issued_at" text NOT NULL,
	"expires_at" text,
	"revoked_at" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_enlistment_grants_grant_id_nonempty" CHECK (length(btrim("app"."group_enlistment_grants"."grant_id")) > 0),
	CONSTRAINT "group_enlistment_grants_revision_positive" CHECK ("app"."group_enlistment_grants"."revision" > 0),
	CONSTRAINT "group_enlistment_grants_issued_nonempty" CHECK (length(btrim("app"."group_enlistment_grants"."issued_at")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."group_sharing_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"grant_id" text NOT NULL,
	"revision" integer NOT NULL,
	"principal_kind" "app"."conversation_principal_kind" NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"scope" text NOT NULL,
	"issued_at" text NOT NULL,
	"expires_at" text,
	"revoked_at" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_sharing_grants_grant_id_nonempty" CHECK (length(btrim("app"."group_sharing_grants"."grant_id")) > 0),
	CONSTRAINT "group_sharing_grants_revision_positive" CHECK ("app"."group_sharing_grants"."revision" > 0),
	CONSTRAINT "group_sharing_grants_issued_nonempty" CHECK (length(btrim("app"."group_sharing_grants"."issued_at")) > 0),
	CONSTRAINT "group_sharing_grants_scope_known" CHECK ("app"."group_sharing_grants"."scope" in ('earlier_history', 'earlier_summary')),
	CONSTRAINT "group_sharing_grants_principal_consistent" CHECK (("app"."group_sharing_grants"."principal_kind" = 'user' and "app"."group_sharing_grants"."user_id" is not null and "app"."group_sharing_grants"."agent_id" is null) or ("app"."group_sharing_grants"."principal_kind" = 'agent' and "app"."group_sharing_grants"."user_id" is null and "app"."group_sharing_grants"."agent_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."group_admissions" ADD CONSTRAINT "group_admissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_admissions" ADD CONSTRAINT "group_admissions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_admissions" ADD CONSTRAINT "group_admissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_admissions" ADD CONSTRAINT "group_admissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_audience_grants" ADD CONSTRAINT "group_audience_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_audience_grants" ADD CONSTRAINT "group_audience_grants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_audience_grants" ADD CONSTRAINT "group_audience_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_enlistment_grants" ADD CONSTRAINT "group_enlistment_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_enlistment_grants" ADD CONSTRAINT "group_enlistment_grants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_enlistment_grants" ADD CONSTRAINT "group_enlistment_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_sharing_grants" ADD CONSTRAINT "group_sharing_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_sharing_grants" ADD CONSTRAINT "group_sharing_grants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "app"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_sharing_grants" ADD CONSTRAINT "group_sharing_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."group_sharing_grants" ADD CONSTRAINT "group_sharing_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_admissions_user_unique" ON "app"."group_admissions" USING btree ("channel_id","user_id") WHERE "app"."group_admissions"."principal_kind" = 'user' and "app"."group_admissions"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "group_admissions_agent_unique" ON "app"."group_admissions" USING btree ("channel_id","agent_id") WHERE "app"."group_admissions"."principal_kind" = 'agent' and "app"."group_admissions"."agent_id" is not null;--> statement-breakpoint
CREATE INDEX "group_admissions_channel_idx" ON "app"."group_admissions" USING btree ("workspace_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_audience_grants_channel_grant_unique" ON "app"."group_audience_grants" USING btree ("channel_id","grant_id");--> statement-breakpoint
CREATE INDEX "group_audience_grants_channel_idx" ON "app"."group_audience_grants" USING btree ("workspace_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_enlistment_grants_channel_grant_unique" ON "app"."group_enlistment_grants" USING btree ("channel_id","grant_id");--> statement-breakpoint
CREATE INDEX "group_enlistment_grants_channel_idx" ON "app"."group_enlistment_grants" USING btree ("workspace_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_sharing_grants_channel_grant_unique" ON "app"."group_sharing_grants" USING btree ("channel_id","grant_id");--> statement-breakpoint
CREATE INDEX "group_sharing_grants_channel_idx" ON "app"."group_sharing_grants" USING btree ("workspace_id","channel_id");