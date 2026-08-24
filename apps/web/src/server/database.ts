import "server-only";

import { createDatabase, type DatabaseConnection } from "@agent-hq/db";

let connection: DatabaseConnection | undefined;
let shutdownRegistered = false;

export async function closeApplicationDatabase() {
  const connectionToClose = connection;
  connection = undefined;
  await connectionToClose?.close();
}

function registerDatabaseShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void closeApplicationDatabase().finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    });
  }
}

export function applicationDatabase() {
  if (!connection) {
    connection = createDatabase();
    registerDatabaseShutdown();
  }
  return connection.db;
}
