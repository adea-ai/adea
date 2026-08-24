import { describe, expect, test } from "bun:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import { authIdentities, users } from "../../src/schema";

describe("identity schema", () => {
  test("keeps stable users separate from provider identities", () => {
    const userConfig = getTableConfig(users);
    const identityConfig = getTableConfig(authIdentities);

    expect(userConfig.schema).toBe("app");
    expect(identityConfig.schema).toBe("app");
    expect(identityConfig.foreignKeys).toHaveLength(1);
    expect(identityConfig.uniqueConstraints).toHaveLength(1);
    expect(identityConfig.indexes.length).toBeGreaterThan(0);
    expect(Object.keys(users)).not.toContain("subject");
    expect(Object.keys(users)).not.toContain("provider");
  });
});
