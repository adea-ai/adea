import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicAssets = resolve(repoRoot, "apps/hq/public/assets");

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

await copyAsset(resolve(repoRoot, "packages/ithappy/assets"), resolve(publicAssets, "ithappy"));

console.log(`Synced HQ assets to ${publicAssets}`);
