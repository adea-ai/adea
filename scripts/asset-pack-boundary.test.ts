import { describe, expect, test } from "bun:test";

const root = new URL("..", import.meta.url).pathname;

const forbiddenExtensions = new Set([".glb", ".gltf", ".fbx", ".obj", ".blend"]);

async function trackedFiles(): Promise<string[]> {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("git ls-files failed");
  return result.stdout.split("\n").filter(Boolean);
}

describe("asset pack boundary", () => {
  test("never tracks 3D/audio binaries anywhere", async () => {
    // Defense in depth alongside .gitignore: no engine binary may ever be
    // tracked, regardless of directory. The engine lives in the private
    // agent-sim repo; this repository ships manifests only.
    const offenders = (await trackedFiles()).filter((file) => {
      const dot = file.lastIndexOf(".");
      return dot !== -1 && forbiddenExtensions.has(file.slice(dot).toLowerCase());
    });
    expect(offenders).toEqual([]);
  });

  test("never tracks fetched or generated asset trees", async () => {
    // vendor/assets is gone with the engine move; apps/*/public/assets holds
    // only synced protocol manifests. apps/mobile/www keeps its placeholder.
    const offenders = (await trackedFiles()).filter((file) => {
      if (file === "vendor/assets" || file.startsWith("vendor/assets/")) return true;
      if (/(^|\/)public\/assets(\/|$)/.test(file)) return true;
      if (file === "apps/mobile/www" || file.startsWith("apps/mobile/www/")) {
        return file !== "apps/mobile/www/index.html";
      }
      return false;
    });
    expect(offenders).toEqual([]);
  });
});
