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
        if (
          entry.isDirectory() &&
          [".next", ".open-next", ".turbo", ".wrangler", "dist", "node_modules"].includes(
            entry.name
          )
        ) {
          return [];
        }
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
      })
    )
  ).flat();
}

describe("authentication provider boundary", () => {
  test("keeps Neon Auth imports inside @adea-ai/auth", async () => {
    for (const directory of ["apps", "packages"]) {
      for (const file of await sourceFiles(join(root, directory))) {
        if (file.includes("/packages/auth/")) continue;
        expect(await readFile(file, "utf8")).not.toContain("@neondatabase/auth");
      }
    }
  });

  test("keeps auth provider schema out of @adea-ai/db", async () => {
    for (const file of await sourceFiles(join(root, "packages/db"))) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain("neon_auth");
      expect(source).not.toContain("better_auth");
    }
  });
});
