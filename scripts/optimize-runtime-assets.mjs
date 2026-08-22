import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeAssetRoots = [
  resolve(repoRoot, "packages/characters/assets"),
  resolve(repoRoot, "packages/pets/assets"),
  resolve(repoRoot, "packages/landscape/assets"),
];

async function* runtimeAssetPaths() {
  for (const assetRoot of runtimeAssetRoots) {
    for await (const relativePath of new Bun.Glob("**/*.glb").scan({ cwd: assetRoot })) {
      yield join(assetRoot, relativePath);
    }
  }
}

function readGlbJson(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error("Invalid GLB header");
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) {
      return JSON.parse(bytes.toString("utf8", offset + 8, offset + 8 + length));
    }
    offset += 8 + length;
  }
  throw new Error("GLB has no JSON chunk");
}

function baseColorMimes(document) {
  const textures = document.textures ?? [];
  const images = document.images ?? [];
  const sources = new Set();
  for (const material of document.materials ?? []) {
    const textureIndex = material.pbrMetallicRoughness?.baseColorTexture?.index;
    const source = textures[textureIndex]?.source;
    if (Number.isInteger(source)) sources.add(source);
  }
  return [...sources].map((source) => images[source]?.mimeType ?? "unknown");
}

function compressionStatus(document) {
  const baseColor = baseColorMimes(document);
  return {
    meshopt: document.extensionsUsed?.includes("EXT_meshopt_compression") ?? false,
    baseColorCompressed: baseColor.every((mime) => mime === "image/webp" || mime === "image/ktx2"),
    baseColor,
  };
}

function runTransform(args) {
  const result = Bun.spawnSync(["bunx", "--bun", "@gltf-transform/cli@4.4.2", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`gltf-transform ${args[0]} failed for ${args[1]}`);
  }
}

async function checkRuntimeAssets() {
  const failures = [];
  let assets = 0;
  let normalMapCandidates = 0;
  let normalMapKtx2 = 0;
  for await (const input of runtimeAssetPaths()) {
    const document = readGlbJson(Buffer.from(await readFile(input)));
    const status = compressionStatus(document);
    assets += 1;
    for (const material of document.materials ?? []) {
      const textureIndex = material.normalTexture?.index;
      const texture = document.textures?.[textureIndex];
      if (!Number.isInteger(textureIndex)) continue;
      normalMapCandidates += 1;
      if (texture?.extensions?.KHR_texture_basisu) normalMapKtx2 += 1;
    }
    if (!status.meshopt)
      failures.push(`${relative(repoRoot, input)} is missing Meshopt compression`);
    if (!status.baseColorCompressed) {
      failures.push(`${relative(repoRoot, input)} has non-compressed base-color textures`);
    }
  }
  console.log(
    `Checked ${assets} runtime assets: Meshopt and WebP/KTX2 base-color compression are present. Normal maps: ${normalMapKtx2}/${normalMapCandidates} KTX2/UASTC-ready.`,
  );
  if (failures.length > 0) {
    throw new Error(`Runtime asset compression gate failed:\n${failures.join("\n")}`);
  }
}

if (process.argv.includes("--check")) {
  await checkRuntimeAssets();
} else {
  const tempRoot = await mkdtemp("/tmp/agent-hq-runtime-assets-");
  let beforeBytes = 0;
  let afterBytes = 0;
  let assets = 0;

  try {
    for await (const input of runtimeAssetPaths()) {
      const document = readGlbJson(Buffer.from(await readFile(input)));
      const status = compressionStatus(document);
      if (status.meshopt && status.baseColorCompressed) {
        console.log(`Skipping already optimized ${relative(repoRoot, input)}`);
        continue;
      }
      const stem = `${assets}-${basename(input, ".glb")}`;
      const webpOutput = join(tempRoot, `${stem}.webp.glb`);
      const meshoptOutput = join(tempRoot, `${stem}.meshopt.glb`);
      const inputStat = await stat(input);

      // Convert only base-color textures to WebP. Normal, metallic-roughness,
      // and occlusion maps stay lossless until a KTX2/UASTC encoder is present.
      // Run Meshopt last: a separate WebP transform decodes an existing
      // EXT_meshopt_compression payload before writing the next GLB.
      runTransform(["webp", input, webpOutput, "--slots", "baseColorTexture", "--quality", "85"]);
      runTransform(["meshopt", webpOutput, meshoptOutput, "--level", "high"]);

      await mkdir(dirname(input), { recursive: true });
      await copyFile(meshoptOutput, input);
      const outputStat = await stat(input);
      beforeBytes += inputStat.size;
      afterBytes += outputStat.size;
      assets += 1;
      console.log(
        `Optimized ${relative(repoRoot, input)} ${(inputStat.size / 1024 / 1024).toFixed(2)} MiB -> ${(outputStat.size / 1024 / 1024).toFixed(2)} MiB`,
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const reduction = beforeBytes > 0 ? (1 - afterBytes / beforeBytes) * 100 : 0;
  console.log(
    `Optimized ${assets} runtime assets: ${(beforeBytes / 1024 / 1024).toFixed(2)} MiB -> ${(afterBytes / 1024 / 1024).toFixed(2)} MiB (${reduction.toFixed(1)}% smaller)`,
  );
}
