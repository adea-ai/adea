import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const assetRoots = [
  "packages/architecture/assets",
  "packages/interior/assets",
  "packages/characters/assets",
  "packages/pets/assets",
  "packages/rooms/assets",
  "packages/landscape/assets",
  "scenes/hq/assets",
];

const binaryExtensions = new Set([
  ".glb",
  ".gltf",
  ".fbx",
  ".obj",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp3",
  ".wav",
  ".ogg",
  ".pdf",
  ".blend",
]);

async function trackedFiles(): Promise<string[]> {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("git ls-files failed");
  return result.stdout.split("\n").filter(Boolean);
}

function packRoot(): string | null {
  const override = process.env.AGENT_HQ_ASSETS_DIR;
  if (override && existsSync(override)) return override;
  const vendor = join(root, "vendor/assets");
  if (existsSync(join(vendor, "packages/interior/assets"))) return vendor;
  return null;
}

describe("asset pack boundary", () => {
  test("keeps binary art out of the public tree", async () => {
    const manifest = JSON.parse(
      await readFile(join(root, "scripts/asset-pack-manifest.json"), "utf8")
    ) as { version: number; files: string[] };
    expect(manifest.version).toBe(1);
    expect(manifest.files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of await trackedFiles()) {
      const underAssetRoot = assetRoots.some(
        (assetRoot) => file === assetRoot || file.startsWith(`${assetRoot}/`)
      );
      if (!underAssetRoot) continue;
      const dot = file.lastIndexOf(".");
      const extension = dot === -1 ? "" : file.slice(dot).toLowerCase();
      if (binaryExtensions.has(extension)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test.if(process.env.AGENT_HQ_ASSETS_DIR || existsSync(join(root, "vendor/assets")))(
    "covers every manifest path when the pack is present",
    async () => {
      const manifest = JSON.parse(
        await readFile(join(root, "scripts/asset-pack-manifest.json"), "utf8")
      ) as { version: number; files: string[] };
      const pack = packRoot();
      expect(pack).not.toBeNull();
      const missing = manifest.files.filter((file) => !existsSync(join(pack!, file)));
      expect(missing).toEqual([]);
    }
  );

  test("never tracks 3D/audio binaries anywhere", async () => {
    // Defense in depth alongside .gitignore: no .glb/.gltf/.fbx/.obj/.blend
    // may ever be tracked, regardless of directory. Icons (.png) stay tracked.
    const forbidden = new Set([".glb", ".gltf", ".fbx", ".obj", ".blend"]);
    const offenders = (await trackedFiles()).filter((file) => {
      const dot = file.lastIndexOf(".");
      return dot !== -1 && forbidden.has(file.slice(dot).toLowerCase());
    });
    expect(offenders).toEqual([]);
  });

  test("never tracks fetched or generated asset trees", async () => {
    // vendor/assets (fetch-assets.mjs) and apps/*/public/assets (sync-assets.mjs)
    // are always fetched/generated. apps/mobile/www keeps only its placeholder.
    const offenders = (await trackedFiles()).filter((file) => {
      if (file === "vendor/assets" || file.startsWith("vendor/assets/")) return true;
      if (file.includes("/public/assets") || file.startsWith("apps/")) {
        if (/(^|\/)public\/assets(\/|$)/.test(file)) return true;
      }
      if (file === "apps/mobile/www" || file.startsWith("apps/mobile/www/")) {
        return file !== "apps/mobile/www/index.html";
      }
      return false;
    });
    expect(offenders).toEqual([]);
  });
});
