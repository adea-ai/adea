import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const appAssets = resolve(root, "apps/hq/public/assets");

await rm(appAssets, { recursive: true, force: true });
await mkdir(appAssets, { recursive: true });
await cp(resolve(root, "packages/ithappy/assets"), resolve(appAssets, "ithappy"), {
  recursive: true,
});
await cp(resolve(root, "packages/rooms/models"), resolve(appAssets, "rooms/models"), {
  recursive: true,
});

for (const scene of ["hq-home", "hq-work"]) {
  const destination = resolve(appAssets, "worlds", scene);
  await cp(resolve(root, "scenes", scene, "assets"), destination, { recursive: true });
  // Foliage manifests point at Nifty World landscape models. HQ only ships
  // its own floor, room, material, and ithappy prop assets.
  await rm(resolve(destination, "foliage.json"), { force: true });
}

console.log("Synced Agent HQ scene, room, and ithappy assets.");
