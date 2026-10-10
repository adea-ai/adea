CREATE TYPE "app"."channel_archive_source" AS ENUM('individual', 'project_cascade');--> statement-breakpoint
ALTER TABLE "app"."channels" ADD COLUMN "archive_source" "app"."channel_archive_source" DEFAULT 'individual' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."projects" ADD CONSTRAINT "projects_version_positive" CHECK ("app"."projects"."version" > 0);