CREATE TYPE "app"."room_lifecycle_state" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "app"."rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"function_key" text NOT NULL,
	"template_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"lifecycle_state" "app"."room_lifecycle_state" DEFAULT 'active' NOT NULL,
	"layout_ref" text,
	"spatial_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_name_nonempty" CHECK (length(btrim("app"."rooms"."name")) > 0),
	CONSTRAINT "rooms_function_key_nonempty" CHECK (length(btrim("app"."rooms"."function_key")) > 0),
	CONSTRAINT "rooms_sort_order_nonnegative" CHECK ("app"."rooms"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."rooms" ADD CONSTRAINT "rooms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rooms_workspace_order_idx" ON "app"."rooms" USING btree ("workspace_id","lifecycle_state","sort_order","id");--> statement-breakpoint
CREATE INDEX "rooms_workspace_function_idx" ON "app"."rooms" USING btree ("workspace_id","function_key");