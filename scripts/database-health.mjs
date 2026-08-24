#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { inspectDatabaseConfiguration } from "./database-config.mjs";

const PRIVILEGE_QUERY = [
  "SELECT current_user,",
  "has_schema_privilege(current_user, 'app', 'CREATE'),",
  "has_database_privilege(current_user, current_database(), 'CREATE'),",
  "rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls",
  "FROM pg_roles WHERE rolname = current_user;",
].join(" ");

function queryPrivileges(rawUrl) {
  const url = new URL(rawUrl);
  const result = spawnSync(
    "psql",
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--field-separator=|",
      "--command",
      PRIVILEGE_QUERY,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PGCHANNELBINDING: url.searchParams.get("channel_binding") ?? "prefer",
        PGCONNECT_TIMEOUT: "10",
        PGDATABASE: url.pathname.slice(1),
        PGHOST: url.hostname,
        PGPASSWORD: decodeURIComponent(url.password),
        PGPORT: url.port || "5432",
        PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
        PGUSER: decodeURIComponent(url.username),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error?.code === "ENOENT") {
    throw new Error("psql is required for the database health check");
  }
  if (result.status !== 0) {
    throw new Error("Database health query failed; connection details were redacted");
  }

  const values = result.stdout.trim().split("|");
  if (values.length !== 8) {
    throw new Error("Database health query returned an unexpected result");
  }
  return {
    canCreateDatabaseObjects: values[2] === "t",
    canCreateSchemaObjects: values[1] === "t",
    elevated: values.slice(3).some((value) => value === "t"),
    role: values[0],
  };
}

try {
  const configuration = inspectDatabaseConfiguration(process.env);
  const runtime = queryPrivileges(process.env.DATABASE_URL);
  const migration = queryPrivileges(process.env.DATABASE_MIGRATION_URL);

  if (runtime.elevated || runtime.canCreateSchemaObjects || runtime.canCreateDatabaseObjects) {
    throw new Error("Runtime database role has elevated or DDL privileges");
  }
  if (
    migration.elevated ||
    !migration.canCreateSchemaObjects ||
    !migration.canCreateDatabaseObjects
  ) {
    throw new Error("Migration database role does not match the required privilege boundary");
  }
  if (
    runtime.role !== configuration.runtimeRole ||
    migration.role !== configuration.migrationRole
  ) {
    throw new Error("Connected database roles do not match the configured roles");
  }

  console.log(
    `Database health check passed (database=${configuration.database}, runtimeRole=${runtime.role}, migrationRole=${migration.role})`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database health check failed");
  process.exitCode = 1;
}
