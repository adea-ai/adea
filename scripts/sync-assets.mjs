import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicAssets = resolve(repoRoot, "apps/web/public/assets");

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

async function writeAssignedPropsManifest(scene, assetDirectory) {
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
    }),
  );
  const destination = resolve(publicAssets, "worlds", scene, "props-runtime.json");
  await writeFile(
    destination,
    `${JSON.stringify({ version: 1, scene, assets, placements }, null, 2)}\n`,
  );
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
  await writeAssignedPropsManifest(scene, assetDirectory);
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
const characterAssetRoot = resolve(repoRoot, "packages/characters/assets");
await copyAsset(characterAssetRoot, resolve(publicAssets, "models"), (sourcePath) => {
  const path = relative(characterAssetRoot, sourcePath).replaceAll("\\", "/");
  // Keep authoring/reference files in the package, but do not ship them to
  // clients because the runtime never loads them.
  return path !== "assets_map.glb" && !path.startsWith("_complete/original-blend/");
});
await copyAsset(
  resolve(repoRoot, "packages/rooms/assets"),
  resolve(publicAssets, "models"),
);

console.log(`Synced HQ assets to ${publicAssets}`);
