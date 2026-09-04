CREATE TYPE "app"."task_kind" AS ENUM('bug', 'feature', 'chore');--> statement-breakpoint
ALTER TABLE "app"."tasks" ADD COLUMN "kind" "app"."task_kind" DEFAULT 'feature' NOT NULL;
