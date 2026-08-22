import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp("/tmp/agent-hq-interior-assets-");

try {
  const { interiorPropAssets } = await import(
    `${repoRoot}/packages/interior/dist/catalog.js?asset-optimizer=${Date.now()}`
  );
  const ids = new Set();
  for (const scene of ["home", "work"]) {
    const document = JSON.parse(
      await readFile(`${repoRoot}/scenes/hq/assets/${scene}/props.json`, "utf8"),
    );
    for (const id of Object.keys(document.placements ?? {})) ids.add(id);
  }

  for (const id of ids) {
    const asset = interiorPropAssets.find((candidate) => candidate.id === id);
    if (!asset) throw new Error(`No catalog asset found for ${id}`);
    const relative = asset.assetUrl.replace(/^\/assets\/models\//, "");
    const input = resolve(repoRoot, "packages/interior/assets", relative);
    const output = join(tempRoot, basename(input));
    const result = Bun.spawnSync(
      [
        "bunx",
        "--bun",
        "@gltf-transform/cli@4.4.2",
        "optimize",
        input,
        output,
        "--compress",
        "meshopt",
        "--texture-compress",
        "webp",
        "--flatten",
        "false",
        "--instance",
        "false",
        "--join",
        "false",
        "--palette",
        "false",
        "--simplify",
        "false",
        "--weld",
        "false",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (result.exitCode !== 0) throw new Error(`Could not optimize ${input}`);

    await mkdir(dirname(input), { recursive: true });
    await copyFile(output, input);
    console.log(`Optimized ${relative}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
