import "server-only";

import { after } from "next/server";

import { createDatabase } from "@agent-hq/db";

import {
  resolveDatabaseConnectionString,
  shouldRegisterDatabaseShutdownHooks,
} from "./database-connection";

let shutdownRegistered = false;

function registerDatabaseShutdown() {
  if (shutdownRegistered || !shouldRegisterDatabaseShutdownHooks()) return;
  shutdownRegistered = true;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

export function applicationDatabase() {
  // Short-lived client per call, closed after the response. Hyperdrive pools
  // at the origin, so worker-side reuse buys nothing — and reused pooled
  // sessions go stale across requests, which hangs requests until the
  // runtime kills them. Per-request lifecycle mirrors a plain Worker, where
  // the same driver, options, and Hyperdrive config answer in ~100ms.
  const connection = createDatabase(resolveDatabaseConnectionString());
  registerDatabaseShutdown();
  try {
    after(() => {
      void connection.close().catch(() => undefined);
    });
  } catch {
    // Outside request scope (build prerender, scripts): rely on isolate GC.
  }
  return connection.db;
}
