import { access, cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicAssets = resolve(repoRoot, "apps/web/public/assets");

async function copyAsset(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function resolveAsset(...candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Workspace installs may expose Three.js through the hoisted root link.
    }
  }
  throw new Error(`Could not find runtime asset in any of: ${candidates.join(", ")}`);
}

await rm(publicAssets, { recursive: true, force: true });
await mkdir(publicAssets, { recursive: true });

const basisTranscoder = await resolveAsset(
  resolve(
    repoRoot,
    "packages/scene-runtime/node_modules/three/examples/jsm/libs/basis/basis_transcoder.js",
  ),
  resolve(repoRoot, "node_modules/three/examples/jsm/libs/basis/basis_transcoder.js"),
);
const basisTranscoderWasm = await resolveAsset(
  resolve(
    repoRoot,
    "packages/scene-runtime/node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm",
  ),
  resolve(repoRoot, "node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm"),
);

await copyAsset(basisTranscoder, resolve(publicAssets, "basis/basis_transcoder.js"));
await copyAsset(basisTranscoderWasm, resolve(publicAssets, "basis/basis_transcoder.wasm"));

for (const [scene, assetDirectory] of [
  ["hq-home", "home"],
  ["hq-work", "work"],
]) {
  await copyAsset(
    resolve(repoRoot, "scenes", "hq", "assets", assetDirectory),
    resolve(publicAssets, "worlds", scene),
  );
}

await copyAsset(resolve(repoRoot, "packages/interior/assets"), resolve(publicAssets, "models"));
await copyAsset(
  resolve(repoRoot, "packages/landscape/assets/foliage"),
  resolve(publicAssets, "models/foliage"),
);
await copyAsset(
  resolve(repoRoot, "packages/landscape/assets/fences"),
  resolve(publicAssets, "models/fences"),
);
await copyAsset(
  resolve(repoRoot, "packages/landscape/assets/backgrounds"),
  resolve(publicAssets, "models/backgrounds"),
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
await copyAsset(
  resolve(repoRoot, "packages/rooms/assets"),
  resolve(publicAssets, "models"),
);

console.log(`Synced HQ assets to ${publicAssets}`);
