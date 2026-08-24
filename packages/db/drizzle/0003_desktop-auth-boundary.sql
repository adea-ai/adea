CREATE TABLE "app"."desktop_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_digest" text NOT NULL,
	"code_challenge" text NOT NULL,
	"nonce" text NOT NULL,
	"provider_expires_at" timestamp with time zone NOT NULL,
	"provider_session_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_authorization_codes_code_digest_unique" UNIQUE("code_digest"),
	CONSTRAINT "desktop_authorization_codes_digest_nonempty" CHECK (length("app"."desktop_authorization_codes"."code_digest") > 0),
	CONSTRAINT "desktop_authorization_codes_challenge_nonempty" CHECK (length("app"."desktop_authorization_codes"."code_challenge") > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."desktop_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"credential_digest" text NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_session_id" text NOT NULL,
	"provider_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_sessions_credential_digest_unique" UNIQUE("credential_digest"),
	CONSTRAINT "desktop_sessions_credential_digest_nonempty" CHECK (length("app"."desktop_sessions"."credential_digest") > 0),
	CONSTRAINT "desktop_sessions_provider_session_nonempty" CHECK (length("app"."desktop_sessions"."provider_session_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."desktop_authorization_codes" ADD CONSTRAINT "desktop_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."desktop_sessions" ADD CONSTRAINT "desktop_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_authorization_codes_expiry_idx" ON "app"."desktop_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "desktop_authorization_codes_user_idx" ON "app"."desktop_authorization_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "desktop_sessions_user_idx" ON "app"."desktop_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "desktop_sessions_active_idx" ON "app"."desktop_sessions" USING btree ("session_id","revoked_at","expires_at");