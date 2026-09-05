import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

describe("cloudflare worker build boundary", () => {
  test("stamps the deployment commit SHA for telemetry without a hosting provider", async () => {
    const source = await readFile(join(root, "scripts/build-cloudflare-worker.mjs"), "utf8");

    expect(source).toContain("DEPLOY_GIT_COMMIT_SHA");
    expect(source).toContain("NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA");
    expect(source).toContain("rev-parse");
    expect(source).not.toContain("VERCEL");
  });
});
