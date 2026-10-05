ALTER TABLE "app"."workspace_memberships" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "accent" text;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "logo_kind" text DEFAULT 'monogram' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "logo_value" text;--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_order_idx" ON "app"."workspace_memberships" USING btree ("user_id","sort_order");--> statement-breakpoint
ALTER TABLE "app"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_sort_order_nonnegative" CHECK ("app"."workspace_memberships"."sort_order" >= 0);--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_accent_valid" CHECK ("app"."workspaces"."accent" is null or "app"."workspaces"."accent" in ('violet', 'blue', 'green', 'amber', 'cyan', 'pink'));--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_logo_valid" CHECK (("app"."workspaces"."logo_kind" = 'monogram' and "app"."workspaces"."logo_value" is null) or ("app"."workspaces"."logo_kind" = 'emoji' and length("app"."workspaces"."logo_value") between 1 and 16));--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_version_positive" CHECK ("app"."workspaces"."version" > 0);--> statement-breakpoint
UPDATE "app"."workspace_memberships" AS "membership"
SET "sort_order" = "ordered"."position"
FROM (
  SELECT "m"."id", row_number() OVER (PARTITION BY "m"."user_id" ORDER BY "w"."created_at", "w"."id") - 1 AS "position"
  FROM "app"."workspace_memberships" AS "m"
  INNER JOIN "app"."workspaces" AS "w" ON "w"."id" = "m"."workspace_id"
) AS "ordered"
WHERE "membership"."id" = "ordered"."id";
