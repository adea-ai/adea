import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

if (!process.env.VERCEL) {
  console.log("Deployment migration skipped outside Vercel.");
  process.exit(0);
}

if (!process.env.DATABASE_MIGRATION_URL) {
  throw new Error("DATABASE_MIGRATION_URL is required for Vercel deployment migrations");
}

const result = spawnSync(
  process.execPath,
  [resolve(root, "packages/db/src/verify-migrations.ts")],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Deployment migration failed with exit code ${result.status}`);
}
