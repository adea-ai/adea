import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicAssets = resolve(repoRoot, "apps/web/public/assets");

async function copyAsset(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

await rm(publicAssets, { recursive: true, force: true });
await mkdir(publicAssets, { recursive: true });

await copyAsset(
  resolve(
    repoRoot,
    "packages/scene-runtime/node_modules/three/examples/jsm/libs/basis/basis_transcoder.js",
  ),
  resolve(publicAssets, "basis/basis_transcoder.js"),
);
await copyAsset(
  resolve(
    repoRoot,
    "packages/scene-runtime/node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm",
  ),
  resolve(publicAssets, "basis/basis_transcoder.wasm"),
);

for (const scene of ["hq-home", "hq-work"]) {
  await copyAsset(
    resolve(repoRoot, "scenes", scene, "assets"),
    resolve(publicAssets, "worlds", scene),
  );
}

await copyAsset(resolve(repoRoot, "packages/models/assets"), resolve(publicAssets, "models"));
await copyAsset(
  resolve(repoRoot, "packages/landscape/assets/foliage"),
  resolve(publicAssets, "models/foliage"),
);
await copyAsset(
  resolve(repoRoot, "packages/landscape/assets/fences"),
  resolve(publicAssets, "models/fences"),
);
await copyAsset(
  resolve(repoRoot, "packages/pets/assets/animals"),
  resolve(publicAssets, "models/animals"),
);
await copyAsset(
  resolve(repoRoot, "packages/characters/assets/characters"),
  resolve(publicAssets, "models/characters"),
);
await copyAsset(
  resolve(repoRoot, "packages/characters/assets/character-parts"),
  resolve(publicAssets, "models/character-parts"),
);

console.log(`Synced HQ assets to ${publicAssets}`);
