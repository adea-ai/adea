ALTER TABLE "app"."workspaces" DROP CONSTRAINT "workspaces_logo_valid";--> statement-breakpoint
ALTER TABLE "app"."workspaces" ALTER COLUMN "logo_kind" SET DEFAULT 'box';--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD COLUMN "is_personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_personal_owner_unique" ON "app"."workspaces" USING btree ("owner_user_id") WHERE "app"."workspaces"."is_personal";--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_personal_active" CHECK (not "app"."workspaces"."is_personal" or ("app"."workspaces"."deleted_at" is null and "app"."workspaces"."deletion_requested_at" is null));--> statement-breakpoint
ALTER TABLE "app"."workspaces" ADD CONSTRAINT "workspaces_logo_valid" CHECK (("app"."workspaces"."logo_kind" in ('monogram', 'home', 'box') and "app"."workspaces"."logo_value" is null) or ("app"."workspaces"."logo_kind" = 'emoji' and length("app"."workspaces"."logo_value") between 1 and 16));
--> statement-breakpoint
-- Only stable seed metadata identifies an existing personal root. Restore a
-- proven archived root rather than losing its content. Never inspect its name,
-- scene or icon, or overwrite customizations. Ambiguous claims get a new root
-- on their next bootstrap; every existing workspace stays intact.
WITH personal_candidates AS (
  SELECT DISTINCT ON (owner_user_id) id
  FROM app.workspaces legacy
  WHERE idempotency_key IN ('default-home', 'default')
    AND NOT EXISTS (SELECT 1 FROM app.workspaces root WHERE root.owner_user_id = legacy.owner_user_id AND root.is_personal)
  ORDER BY owner_user_id,
    CASE WHEN idempotency_key = 'default-home' THEN 0 ELSE 1 END,
    created_at, id
)
UPDATE app.workspaces SET is_personal = true, deleted_at = NULL, deletion_requested_at = NULL
WHERE id IN (SELECT id FROM personal_candidates);
