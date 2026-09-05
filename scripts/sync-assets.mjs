import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicAssets = resolve(repoRoot, "apps/web/public/assets");
// Build into a staging directory and swap it over the live tree atomically.
// The desktop vite build copies apps/web/public while the web build syncs it;
// swapping complete trees (instead of wiping public/assets first) means
// concurrent readers only ever see a complete old or complete new tree.
const stagingAssets = `${publicAssets}.staging-${process.pid}`;
const backupAssets = `${publicAssets}.backup-${process.pid}`;

async function copyAsset(source, destination, filter) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: true,
    ...(filter ? { filter } : {}),
  });
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

async function writeAssignedPropsManifest(scene, assetDirectory, assetsRoot) {
  // Bun can load the TypeScript catalog directly. Keeping this transform in
  // the asset sync step means the HQ bundle only needs the placed assets and
  // never imports the authoring catalog.
  const { interiorPropAssets } = await import(
    pathToFileURL(resolve(repoRoot, "packages/interior/src/catalog.ts")).href
  );
  const catalogById = new Map(interiorPropAssets.map((asset) => [asset.id, asset]));
  const propsPath = resolve(repoRoot, "scenes/hq/assets", assetDirectory, "props.json");
  const document = JSON.parse(await readFile(propsPath, "utf8"));
  const placements = document.placements ?? {};
  const assets = Object.fromEntries(
    Object.keys(placements).flatMap((modelId) => {
      const asset = catalogById.get(modelId);
      if (!asset) {
        console.warn(`[Agent HQ] Missing interior catalog entry for assigned prop ${modelId}.`);
        return [];
      }
      return [
        [
          modelId,
          {
            assetUrl: asset.assetUrl,
            defaultScale: asset.defaultScale,
            footprint: asset.footprint,
            placementSurface: asset.placementSurface,
            wallMountHeight: asset.wallMountHeight,
            floorLift: asset.floorLift,
            placeableOnTop: asset.placeableOnTop,
          },
        ],
      ];
    })
  );
  const destination = resolve(assetsRoot, "worlds", scene, "props-runtime.json");
  const temporaryDestination = `${destination}.tmp-${process.pid}`;
  await writeFile(
    temporaryDestination,
    `${JSON.stringify({ version: 1, scene, assets, placements }, null, 2)}\n`
  );
  await rename(temporaryDestination, destination);
}

await rm(stagingAssets, { recursive: true, force: true });
await mkdir(stagingAssets, { recursive: true });

const basisTranscoder = await resolveAsset(
  resolve(
    repoRoot,
    "packages/scene-runtime/node_modules/three/examples/jsm/libs/basis/basis_transcoder.js"
  ),
  resolve(repoRoot, "node_modules/three/examples/jsm/libs/basis/basis_transcoder.js")
);
const basisTranscoderWasm = await resolveAsset(
  resolve(
    repoRoot,
    "packages/scene-runtime/node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm"
  ),
  resolve(repoRoot, "node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm")
);

await copyAsset(basisTranscoder, resolve(stagingAssets, "basis/basis_transcoder.js"));
await copyAsset(basisTranscoderWasm, resolve(stagingAssets, "basis/basis_transcoder.wasm"));

for (const [scene, assetDirectory] of [
  ["hq-home", "home"],
  ["hq-work", "work"],
]) {
  await copyAsset(
    resolve(repoRoot, "scenes", "hq", "assets", assetDirectory),
    resolve(stagingAssets, "worlds", scene)
  );
  await writeAssignedPropsManifest(scene, assetDirectory, stagingAssets);
}

await copyAsset(resolve(repoRoot, "packages/interior/assets"), resolve(stagingAssets, "models"));
await copyAsset(
  resolve(repoRoot, "packages/landscape/assets/foliage"),
  resolve(stagingAssets, "models/foliage")
);
await copyAsset(
  resolve(repoRoot, "packages/landscape/assets/fences"),
  resolve(stagingAssets, "models/fences")
);
await copyAsset(
  resolve(repoRoot, "packages/landscape/assets/backgrounds"),
  resolve(stagingAssets, "models/backgrounds")
);
await copyAsset(
  resolve(repoRoot, "packages/pets/assets/animals"),
  resolve(stagingAssets, "models/animals")
);
const characterAssetRoot = resolve(repoRoot, "packages/characters/assets");
await copyAsset(characterAssetRoot, resolve(stagingAssets, "models"), (sourcePath) => {
  const path = relative(characterAssetRoot, sourcePath).replaceAll("\\", "/");
  // Keep authoring/reference files in the package, but do not ship them to
  // clients because the runtime never loads them.
  return path !== "assets_map.glb" && !path.startsWith("_complete/original-blend/");
});
await copyAsset(resolve(repoRoot, "packages/rooms/assets"), resolve(stagingAssets, "models"));

// Swap the complete staging tree over the live one. Readers concurrent with
// the sync only ever observe a complete tree (old or new).
await rm(backupAssets, { recursive: true, force: true });
try {
  await rename(publicAssets, backupAssets);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await rename(stagingAssets, publicAssets);
await rm(backupAssets, { recursive: true, force: true });

console.log(`Synced HQ assets to ${publicAssets}`);
