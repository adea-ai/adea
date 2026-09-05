import { sql } from "drizzle-orm";
import { check, index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { entityId, timestampColumns } from "./conventions";
import { users } from "./identity";
import { appSchema } from "./schema";

export const desktopAuthorizationCodes = appSchema.table(
  "desktop_authorization_codes",
  {
    id: entityId(),
    codeDigest: text("code_digest").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    nonce: text("nonce").notNull(),
    providerExpiresAt: timestamp("provider_expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    providerSessionId: text("provider_session_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("desktop_authorization_codes_digest_nonempty", sql`length(${table.codeDigest}) > 0`),
    check(
      "desktop_authorization_codes_challenge_nonempty",
      sql`length(${table.codeChallenge}) > 0`
    ),
    index("desktop_authorization_codes_expiry_idx").on(table.expiresAt),
    index("desktop_authorization_codes_user_idx").on(table.userId),
    unique("desktop_authorization_codes_code_digest_unique").on(table.codeDigest),
  ]
);

export const desktopSessions = appSchema.table(
  "desktop_sessions",
  {
    sessionId: uuid("session_id").primaryKey(),
    credentialDigest: text("credential_digest").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerSessionId: text("provider_session_id").notNull(),
    providerExpiresAt: timestamp("provider_expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique("desktop_sessions_credential_digest_unique").on(table.credentialDigest),
    check(
      "desktop_sessions_credential_digest_nonempty",
      sql`length(${table.credentialDigest}) > 0`
    ),
    check(
      "desktop_sessions_provider_session_nonempty",
      sql`length(${table.providerSessionId}) > 0`
    ),
    index("desktop_sessions_user_idx").on(table.userId),
    index("desktop_sessions_active_idx").on(table.sessionId, table.revokedAt, table.expiresAt),
  ]
);
