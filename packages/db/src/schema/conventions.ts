import { timestamp, uuid } from "drizzle-orm/pg-core";

export function entityId(name = "id") {
  return uuid(name).defaultRandom().primaryKey();
}

export function timestampColumns() {
  return {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  };
}

export function softDeleteColumns() {
  return {
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  };
}

export type JsonObject = Record<string, unknown>;
