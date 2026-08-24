import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  commandOutbox,
  desktopAuthorizationCodes,
  eventInbox,
  workspaceEvents,
  workspaces,
} from "../../src/schema";

describe("persistence schema", () => {
  test("keeps foundational tables in the app schema", () => {
    for (const table of [workspaces, workspaceEvents, commandOutbox, eventInbox]) {
      expect(getTableConfig(table).schema).toBe("app");
    }
  });

  test("represents constraints and indexes in schema metadata", () => {
    const workspaceEventConfig = getTableConfig(workspaceEvents);
    const commandOutboxConfig = getTableConfig(commandOutbox);
    const eventInboxConfig = getTableConfig(eventInbox);

    expect(workspaceEventConfig.foreignKeys).toHaveLength(1);
    expect(workspaceEventConfig.indexes.length).toBeGreaterThan(0);
    expect(commandOutboxConfig.foreignKeys).toHaveLength(1);
    expect(commandOutboxConfig.indexes.length).toBeGreaterThan(0);
    expect(eventInboxConfig.uniqueConstraints.length).toBeGreaterThan(0);
  });

  test("uses a UUID primary key and a unique digest for desktop authorization codes", () => {
    const config = getTableConfig(desktopAuthorizationCodes);

    expect(config.primaryKeys).toHaveLength(0);
    expect(config.columns.find((column) => column.name === "id")?.primary).toBe(true);
    expect(
      config.uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === "code_digest"),
      ),
    ).toBe(true);
  });
});
