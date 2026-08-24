CREATE TABLE "app"."auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_provider_subject_unique" UNIQUE("provider","subject"),
	CONSTRAINT "auth_identities_provider_nonempty" CHECK (length(btrim("app"."auth_identities"."provider")) > 0),
	CONSTRAINT "auth_identities_subject_nonempty" CHECK (length(btrim("app"."auth_identities"."subject")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "app"."auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_identities_resolution_idx" ON "app"."auth_identities" USING btree ("provider","subject","revoked_at");--> statement-breakpoint
CREATE INDEX "users_active_idx" ON "app"."users" USING btree ("disabled_at");