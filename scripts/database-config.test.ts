import { describe, expect, test } from "bun:test";

import { inspectDatabaseConfiguration } from "./database-config.mjs";

const localEnvironment = {
  DATABASE_URL:
    "postgresql://agent_hq_local_app:local-password@127.0.0.1:55432/agent_hq?sslmode=disable",
  DATABASE_URL_UNPOOLED:
    "postgresql://agent_hq_local_app:local-password@127.0.0.1:55432/agent_hq?sslmode=disable",
  DATABASE_MIGRATION_URL:
    "postgresql://agent_hq_local_migration:local-password@127.0.0.1:55432/agent_hq?sslmode=disable",
};

describe("inspectDatabaseConfiguration", () => {
  test("accepts the standard local PostgreSQL configuration without returning credentials", () => {
    const result = inspectDatabaseConfiguration(localEnvironment);

    expect(result).toEqual({
      database: "agent_hq",
      hosted: false,
      migrationRole: "agent_hq_local_migration",
      runtimeRole: "agent_hq_local_app",
    });
    expect(JSON.stringify(result)).not.toContain("local-password");
  });

  test("requires TLS for hosted PostgreSQL connections", () => {
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        DATABASE_URL:
          "postgresql://agent_hq_prod_app:secret@prod.example.com/agent_hq?sslmode=disable",
      }),
    ).toThrow("Hosted DATABASE_URL must require TLS");
  });

  test("keeps runtime and migration credentials separate", () => {
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        DATABASE_MIGRATION_URL: localEnvironment.DATABASE_URL,
      }),
    ).toThrow("must use different roles");
  });

  test("rejects client-exposed database credentials", () => {
    expect(() =>
      inspectDatabaseConfiguration({
        ...localEnvironment,
        NEXT_PUBLIC_DATABASE_URL: localEnvironment.DATABASE_URL,
      }),
    ).toThrow("must never be client-exposed");
  });
});
