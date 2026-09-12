CREATE TYPE "app"."runtime_node_challenge_purpose" AS ENUM('pair', 'rotate', 'proof');--> statement-breakpoint
CREATE TYPE "app"."runtime_node_key_algorithm" AS ENUM('ed25519', 'x25519');--> statement-breakpoint
CREATE TYPE "app"."runtime_node_key_role" AS ENUM('signing', 'command_encryption');--> statement-breakpoint
CREATE TYPE "app"."runtime_node_kind" AS ENUM('local_device', 'remote_host');--> statement-breakpoint
CREATE TYPE "app"."runtime_node_pairing_state" AS ENUM('paired', 'revoked');--> statement-breakpoint
ALTER TYPE "app"."workspace_event_aggregate_type" ADD VALUE IF NOT EXISTS 'runtime_node';--> statement-breakpoint
CREATE TABLE "app"."runtime_node_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"runtime_node_id" uuid,
	"purpose" "app"."runtime_node_challenge_purpose" NOT NULL,
	"kind" "app"."runtime_node_kind" NOT NULL,
	"nonce" text NOT NULL,
	"audience" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_node_challenges_audience_bounded" CHECK (char_length("app"."runtime_node_challenges"."audience") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_node_exchange_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"challenge_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_node_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runtime_node_id" uuid NOT NULL,
	"role" "app"."runtime_node_key_role" NOT NULL,
	"algorithm" "app"."runtime_node_key_algorithm" NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"key_version" integer NOT NULL,
	"verified_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_node_keys_key_version_positive" CHECK ("app"."runtime_node_keys"."key_version" > 0),
	CONSTRAINT "runtime_node_keys_role_algorithm_match" CHECK (("app"."runtime_node_keys"."role" = 'signing' and "app"."runtime_node_keys"."algorithm" = 'ed25519') or ("app"."runtime_node_keys"."role" = 'command_encryption' and "app"."runtime_node_keys"."algorithm" = 'x25519'))
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"kind" "app"."runtime_node_kind" NOT NULL,
	"display_name" text NOT NULL,
	"platform" text NOT NULL,
	"software_version" text NOT NULL,
	"pairing_state" "app"."runtime_node_pairing_state" DEFAULT 'paired' NOT NULL,
	"trust_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_proof_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_nodes_revocation_consistent" CHECK (("app"."runtime_nodes"."pairing_state" = 'revoked' and "app"."runtime_nodes"."revoked_at" is not null) or ("app"."runtime_nodes"."pairing_state" = 'paired' and "app"."runtime_nodes"."revoked_at" is null)),
	CONSTRAINT "runtime_nodes_display_name_bounded" CHECK (char_length("app"."runtime_nodes"."display_name") between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "app"."runtime_node_challenges" ADD CONSTRAINT "runtime_node_challenges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_node_challenges" ADD CONSTRAINT "runtime_node_challenges_runtime_node_id_runtime_nodes_id_fk" FOREIGN KEY ("runtime_node_id") REFERENCES "app"."runtime_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_node_challenges" ADD CONSTRAINT "runtime_node_challenges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_node_exchange_credentials" ADD CONSTRAINT "runtime_node_exchange_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_node_exchange_credentials" ADD CONSTRAINT "runtime_node_exchange_credentials_challenge_id_runtime_node_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "app"."runtime_node_challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_node_keys" ADD CONSTRAINT "runtime_node_keys_runtime_node_id_runtime_nodes_id_fk" FOREIGN KEY ("runtime_node_id") REFERENCES "app"."runtime_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_nodes" ADD CONSTRAINT "runtime_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_nodes" ADD CONSTRAINT "runtime_nodes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_node_challenges_nonce_uidx" ON "app"."runtime_node_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "runtime_node_challenges_open_idx" ON "app"."runtime_node_challenges" USING btree ("workspace_id","purpose","expires_at");--> statement-breakpoint
CREATE INDEX "runtime_node_challenges_node_idx" ON "app"."runtime_node_challenges" USING btree ("runtime_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_node_exchange_credentials_digest_uidx" ON "app"."runtime_node_exchange_credentials" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "runtime_node_exchange_credentials_challenge_idx" ON "app"."runtime_node_exchange_credentials" USING btree ("challenge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_node_keys_version_uidx" ON "app"."runtime_node_keys" USING btree ("runtime_node_id","role","key_version");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_node_keys_fingerprint_uidx" ON "app"."runtime_node_keys" USING btree ("runtime_node_id","fingerprint");--> statement-breakpoint
CREATE INDEX "runtime_node_keys_node_idx" ON "app"."runtime_node_keys" USING btree ("runtime_node_id","role");--> statement-breakpoint
CREATE INDEX "runtime_nodes_workspace_idx" ON "app"."runtime_nodes" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "runtime_nodes_owner_idx" ON "app"."runtime_nodes" USING btree ("owner_user_id");