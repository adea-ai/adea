import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("test suite boundaries", () => {
  test("exposes Code Foundry entry points for every test category", () => {
    expect(packageJson.scripts.test).toBe("bun run test:unit");
    expect(packageJson.scripts["test:unit"]).toContain("turbo run test");
    expect(packageJson.scripts["test:unit"]).toContain("bun run test:coverage");
    expect(packageJson.scripts["test:integration"]).toBe("bun test packages/*/tests/integration");
    expect(packageJson.scripts["test:e2e"]).toContain("playwright");
    expect(packageJson.scripts["test:smoke"]).toBe("bun run native:smoke");
    expect(packageJson.scripts["release:manual"]).toBe("bun scripts/manual-release.mjs");
  });

  test("keeps smoke validation independent from the build lane", () => {
    expect(packageJson.scripts.build).not.toContain("native:smoke");
  });

  test("enforces the repository coverage goal on durable core code", () => {
    expect(packageJson.scripts["test:coverage"]).toBe(
      "bun test packages/auth/tests/unit packages/db/tests/unit scripts/*.test.ts --coverage",
    );

    const bunfig = readFileSync(resolve(root, "bunfig.toml"), "utf8");
    expect(bunfig).toContain("coverageThreshold = { line = 0.8, function = 0.8 }");
    expect(bunfig).toContain("coverageSkipTestFiles = true");
    expect(bunfig).toContain('coverageReporter = ["text", "lcov"]');
    expect(bunfig).toContain('coverageDir = "coverage"');

    const codeFoundry = readFileSync(resolve(root, ".github/code-foundry.yml"), "utf8");
    expect(codeFoundry).toContain("coverage_minimum: 80");
  });

  test("runs the database-backed integration category in the Neon lane", () => {
    const neonWorkflow = readFileSync(resolve(root, ".github/workflows/neon_workflow.yml"), "utf8");
    expect(neonWorkflow).toContain("bun run test:integration");
    expect(neonWorkflow).not.toContain("packages/db test:integration");
    expect(neonWorkflow).not.toContain("packages/auth test:integration");
  });
});
