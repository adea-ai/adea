CREATE TYPE "app"."project_member_role" AS ENUM('viewer', 'editor');--> statement-breakpoint
CREATE TYPE "app"."project_visibility" AS ENUM('workspace', 'members');--> statement-breakpoint
CREATE TYPE "app"."workspace_invitation_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "app"."project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "app"."project_member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_user_unique" UNIQUE("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "app"."workspace_invitation_role" NOT NULL,
	"token_digest" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invitations_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "workspace_invitations_email_normalized" CHECK ("app"."workspace_invitations"."email" = lower(btrim("app"."workspace_invitations"."email")) and length("app"."workspace_invitations"."email") between 3 and 320 and position('@' in "app"."workspace_invitations"."email") > 1),
	CONSTRAINT "workspace_invitations_token_digest_valid" CHECK ("app"."workspace_invitations"."token_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_invitations_accept_consistent" CHECK (("app"."workspace_invitations"."accepted_at" is null) = ("app"."workspace_invitations"."accepted_by_user_id" is null)),
	CONSTRAINT "workspace_invitations_settled_once" CHECK ("app"."workspace_invitations"."accepted_at" is null or "app"."workspace_invitations"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "app"."projects" ADD COLUMN "visibility" "app"."project_visibility" DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."project_members" ADD CONSTRAINT "project_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "app"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_members_workspace_user_idx" ON "app"."project_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_pending_unique" ON "app"."workspace_invitations" USING btree ("workspace_id","email") WHERE "app"."workspace_invitations"."accepted_at" is null and "app"."workspace_invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_idx" ON "app"."workspace_invitations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "projects_workspace_visibility_idx" ON "app"."projects" USING btree ("workspace_id","visibility");