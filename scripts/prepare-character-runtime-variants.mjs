import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  console.error(
    "Usage: bun scripts/prepare-character-runtime-variants.mjs --input <library.glb> --output <variant.glb> --parts <name,...>"
  );
  process.exit(1);
}

function readGlb(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "glTF") throw new Error("Invalid GLB header");
  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) throw new Error("GLB JSON chunk must be first");
  const json = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength).trim());
  let bin;
  let offset = 20 + jsonLength;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    if (type === 0x004e4942) bin = Buffer.from(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  if (!bin) throw new Error("GLB has no binary chunk");
  return { json, bin };
}

function writeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.concat([
    jsonBytes,
    Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20),
  ]);
  const paddedBin = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(paddedBin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBin]);
}

async function runTransform(args) {
  const child = Bun.spawn(["bunx", "--bun", "@gltf-transform/cli@4.4.2", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`gltf-transform ${args[0]} failed for ${args[1]}`);
}

const input = argument("--input");
const output = argument("--output");
const parts = argument("--parts")
  ?.split(",")
  .map((part) => part.trim())
  .filter(Boolean);
if (!input || !output || !parts?.length) usage();

const inputPath = resolve(repoRoot, input);
const outputPath = resolve(repoRoot, output);
const { json, bin } = readGlb(await readFile(inputPath));
const sceneRootIds = json.scenes?.flatMap((scene) => scene.nodes ?? []) ?? [];
const skeletonRootId = sceneRootIds.find((nodeId) => json.nodes?.[nodeId]?.name === "Skeleton_01");
if (!Number.isInteger(skeletonRootId)) throw new Error("Character library is missing Skeleton_01");
const skeletonRoot = json.nodes[skeletonRootId];
const selected = new Set(parts);
const selectedChildren = (skeletonRoot.children ?? []).filter((nodeId) => {
  const name = json.nodes?.[nodeId]?.name;
  return name === "Root" || (name && selected.has(name));
});
const selectedNames = new Set(
  selectedChildren.map((nodeId) => json.nodes?.[nodeId]?.name).filter(Boolean)
);
const missing = parts.filter((part) => !selectedNames.has(part));
if (missing.length > 0)
  throw new Error(`Character library is missing parts: ${missing.join(", ")}`);
skeletonRoot.children = selectedChildren;

const temporaryRoot = await mkdtemp("/tmp/agent-hq-character-variant-");
const unprunedPath = join(temporaryRoot, "selected.unpruned.glb");
const prunedPath = join(temporaryRoot, "selected.pruned.glb");
try {
  await writeFile(unprunedPath, writeGlb(json, bin));
  await runTransform(["prune", unprunedPath, prunedPath]);
  await runTransform([
    "meshopt",
    prunedPath,
    outputPath,
    "--level",
    "high",
    "--quantize-position",
    "16",
    "--quantize-normal",
    "16",
    "--quantize-texcoord",
    "16",
    "--quantize-color",
    "16",
    "--quantize-generic",
    "16",
    "--quantize-weight",
    "16",
  ]);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(
  `Prepared ${parts.length} character parts from ${input} -> ${output} (${dirname(outputPath)})`
);
