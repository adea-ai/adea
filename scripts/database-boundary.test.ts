import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
      })
    )
  ).flat();
}

describe("database package boundary", () => {
  test("does not expose database subpaths", async () => {
    const manifest = JSON.parse(await readFile(join(root, "packages/db/package.json"), "utf8"));
    expect(Object.keys(manifest.exports)).toEqual([".", "./config"]);
  });

  test("keeps database imports out of mobile and desktop bundles", async () => {
    for (const app of ["mobile", "desktop"]) {
      for (const file of await sourceFiles(join(root, "apps", app))) {
        expect(await readFile(file, "utf8")).not.toContain("@agent-hq/db");
      }
    }
  });

  test("keeps database imports out of client components", async () => {
    for (const file of await sourceFiles(join(root, "apps/web/src"))) {
      const source = await readFile(file, "utf8");
      if (/^[\s\n]*["']use client["'];/m.test(source)) {
        expect(source).not.toContain("@agent-hq/db");
      }
    }
  });

  test("declares every internal package imported by the web application", async () => {
    const manifest = JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const importedPackages = new Set<string>();
    for (const file of await sourceFiles(join(root, "apps/web/src"))) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/(?:from\s+|import\s*)["'](@agent-hq\/[^/"']+)/g)) {
        importedPackages.add(match[1]!);
      }
    }

    for (const packageName of importedPackages) {
      expect(manifest.dependencies).toHaveProperty(packageName);
    }
  });

  test("closes per-request database connections and keeps shutdown hooks", async () => {
    const source = await readFile(join(root, "apps/web/src/server/database.ts"), "utf8");

    // Worker-side pooled sessions go stale across requests, so each call opens
    // a short-lived client that is closed after the response. The ./config
    // subpath above stays validation-only: no client, pool, or server-only.
    expect(source).toContain("after(");
    expect(source).toContain(".close()");
    expect(source).toContain('["SIGINT", "SIGTERM"]');
    expect(source).toContain("process.once(signal");
  });

  test("applies reviewed migrations for every Cloudflare Worker deployment", async () => {
    const workflow = await readFile(
      join(root, ".github/workflows/cloudflare-db-migrate.yml"),
      "utf8"
    );

    expect(workflow).toContain("DATABASE_MIGRATION_URL");
    expect(workflow).toContain("db:verify");
    expect(workflow).toContain("packages/db/drizzle/**");
  });
});
