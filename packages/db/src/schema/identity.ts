import { sql } from "drizzle-orm";
import { check, index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { entityId, timestampColumns } from "./conventions";
import { appSchema } from "./schema";

export const users = appSchema.table(
  "users",
  {
    id: entityId(),
    displayName: text("display_name"),
    disabledAt: timestamp("disabled_at", { mode: "date", withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [index("users_active_idx").on(table.disabledAt)],
);

export const authIdentities = appSchema.table(
  "auth_identities",
  {
    id: entityId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    ...timestampColumns(),
  },
  (table) => [
    unique("auth_identities_provider_subject_unique").on(table.provider, table.subject),
    check("auth_identities_provider_nonempty", sql`length(btrim(${table.provider})) > 0`),
    check("auth_identities_subject_nonempty", sql`length(btrim(${table.subject})) > 0`),
    index("auth_identities_user_idx").on(table.userId),
    index("auth_identities_resolution_idx").on(table.provider, table.subject, table.revokedAt),
  ],
);
