import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { readDatabaseUrl } from "./config";
import * as schema from "./schema";

export function createDatabase(connectionUrl = readDatabaseUrl()) {
  const client = postgres(connectionUrl, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 20,
    prepare: false,
  });

  return {
    client,
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

export type DatabaseConnection = ReturnType<typeof createDatabase>;
export type AgentHqDatabase = DatabaseConnection["db"];
export type AgentHqTransaction = Parameters<Parameters<AgentHqDatabase["transaction"]>[0]>[0];
