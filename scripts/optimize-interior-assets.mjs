/* global Bun */

const result = Bun.spawnSync(["bun", "scripts/optimize-runtime-assets.mjs", "--scope=interior"], {
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  throw new Error("Interior asset optimization failed");
}
