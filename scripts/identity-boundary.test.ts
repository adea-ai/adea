import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isPrincipalRef, isUserPrincipalRef, type PrincipalRef } from "../packages/types/src/index";

const root = new URL("..", import.meta.url).pathname;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (
          entry.isDirectory() &&
          [".next", ".turbo", "dist", "node_modules"].includes(entry.name)
        ) {
          return [];
        }
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
      })
    )
  ).flat();
}

describe("principal boundary", () => {
  test("distinguishes every principal kind without provider identifiers", () => {
    const principals: PrincipalRef[] = [
      { kind: "user", userId: "user-1" },
      { kind: "service", serviceId: "service-1" },
      { kind: "runtime_node", runtimeNodeId: "node-1" },
      { kind: "agent", agentId: "agent-1" },
      { kind: "worker", workerId: "worker-1" },
    ];

    expect(principals.map(({ kind }) => kind)).toEqual([
      "user",
      "service",
      "runtime_node",
      "agent",
      "worker",
    ]);
    expect(principals.filter(isUserPrincipalRef)).toEqual([{ kind: "user", userId: "user-1" }]);
    expect(principals.every(isPrincipalRef)).toBe(true);
    expect(isPrincipalRef({ kind: "user", subject: "provider-subject" })).toBe(false);
    expect(isPrincipalRef({ kind: "user", userId: "user-1", subject: "provider-subject" })).toBe(
      false
    );
    expect(isPrincipalRef({ kind: "runtime_node", runtimeNodeId: "" })).toBe(false);
    expect(JSON.stringify(principals)).not.toContain("subject");
    expect(JSON.stringify(principals)).not.toContain("provider");
  });

  test("keeps provider subjects out of workspace and control-plane contracts", async () => {
    const protectedDirectories = [
      join(root, "packages/api-client"),
      join(root, "packages/app-core"),
      join(root, "packages/types"),
    ];

    for (const directory of protectedDirectories) {
      for (const file of await sourceFiles(directory)) {
        const source = await readFile(file, "utf8");
        expect(source).not.toMatch(/neon(?:Auth)?(?:User)?Id/i);
        expect(source).not.toMatch(/providerSubject/i);
      }
    }
  });
});
