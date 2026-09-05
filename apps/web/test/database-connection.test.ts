import { describe, expect, test } from "bun:test";

import {
  resolveDatabaseConnectionString,
  shouldRegisterDatabaseShutdownHooks,
} from "../src/server/database-connection";

const VALID_URL = "postgresql://app:secret@db.example.com:5432/agent_hq";

describe("database connection resolution", () => {
  test("returns DATABASE_URL when no Hyperdrive binding is present", () => {
    expect(resolveDatabaseConnectionString({ DATABASE_URL: VALID_URL })).toBe(VALID_URL);
  });

  test("requires DATABASE_URL when no Hyperdrive binding is present", () => {
    expect(() => resolveDatabaseConnectionString({})).toThrow("DATABASE_URL is required");
  });

  test("rejects client-exposed database keys", () => {
    expect(() =>
      resolveDatabaseConnectionString({
        DATABASE_URL: VALID_URL,
        NEXT_PUBLIC_DATABASE_URL: VALID_URL,
      })
    ).toThrow("must never be client-exposed");
  });

  test("registers shutdown hooks outside the Workers runtime", () => {
    expect(shouldRegisterDatabaseShutdownHooks()).toBe(true);
  });
});
