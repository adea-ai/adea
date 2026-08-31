import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Agent HQ scenes use this shared exterior catalog. Its source models live in
// this package so outdoor assets stay separate from room-designer props.
const assetRoot = "/assets/models/foliage";
const fenceRoot = "/assets/models/fences";
const backgroundRoot = "/assets/models/backgrounds";

export const landscapeHorizonBackgrounds = {
  home: `${backgroundRoot}/background_seasons_3.jpg`,
  work: `${backgroundRoot}/background_urban_4.jpg`,
} as const;

export const foliageAssets = [
  {
    id: "bush-06",
    label: "Bush",
    assetUrl: `${assetRoot}/Bush_06.glb`,
  },
  {
    id: "bush-07",
    label: "Bush Round",
    assetUrl: `${assetRoot}/Bush_07.glb`,
  },
  {
    id: "bush-10",
    label: "Bush Wide",
    assetUrl: `${assetRoot}/Bush_10.glb`,
  },
  {
    id: "palm-03",
    label: "Palm Tree",
    assetUrl: `${assetRoot}/Palm_03.glb`,
  },
  {
    id: "deco-fern-large",
    label: "Deco Fern Large",
    assetUrl: `${assetRoot}/shrubs/deco-fern-large.glb`,
  },
  {
    id: "spider-plant-bush-large",
    label: "Spider Plant Bush Large",
    assetUrl: `${assetRoot}/shrubs/spider-plant-bush-large.glb`,
  },
  {
    id: "cherryblossom-potted-01",
    label: "Cherry Blossom Potted 01",
    assetUrl: `${assetRoot}/trees/cherryblossom-potted-01.glb`,
  },
  {
    id: "cherryblossom-potted-02",
    label: "Cherry Blossom Potted 02",
    assetUrl: `${assetRoot}/trees/cherryblossom-potted-02.glb`,
  },
  {
    id: "mansion-tree-2",
    label: "Mansion Tree 2",
    assetUrl: `${assetRoot}/trees/mansion-tree-2.glb`,
  },
] as const;

export const fenceAssets = [
  {
    id: "fence-07",
    label: "Fence",
    assetUrl: `${fenceRoot}/Fence_07.glb`,
  },
  {
    id: "fence-08",
    label: "Fence Short",
    assetUrl: `${fenceRoot}/Fence_08.glb`,
  },
  {
    id: "fence-09",
    label: "Fence Long",
    assetUrl: `${fenceRoot}/Fence_09.glb`,
  },
] as const;

export const landscapeAssets = [...foliageAssets, ...fenceAssets] as const;

export const backgroundAssets = [
  {
    id: "seasons-1",
    label: "Seasons 1",
    assetUrl: `${backgroundRoot}/background_seasons_1.jpg`,
  },
  {
    id: "seasons-2",
    label: "Seasons 2",
    assetUrl: `${backgroundRoot}/background_seasons_2.jpg`,
  },
  {
    id: "seasons-3",
    label: "Seasons 3",
    assetUrl: `${backgroundRoot}/background_seasons_3.jpg`,
  },
  {
    id: "seasons-4",
    label: "Seasons 4",
    assetUrl: `${backgroundRoot}/background_seasons_4.jpg`,
  },
  {
    id: "urban-1",
    label: "Urban 1",
    assetUrl: `${backgroundRoot}/background_urban_1.jpg`,
  },
  {
    id: "urban-2",
    label: "Urban 2",
    assetUrl: `${backgroundRoot}/background_urban_2.jpg`,
  },
  {
    id: "urban-3",
    label: "Urban 3",
    assetUrl: `${backgroundRoot}/background_urban_3.jpg`,
  },
  {
    id: "urban-4",
    label: "Urban 4",
    assetUrl: `${backgroundRoot}/background_urban_4.jpg`,
  },
] as const;

export type FoliageId = (typeof foliageAssets)[number]["id"];
export type FenceId = (typeof fenceAssets)[number]["id"];
export type LandscapeId = (typeof landscapeAssets)[number]["id"];
export type LandscapeManifest = (typeof landscapeAssets)[number];
export type BackgroundId = (typeof backgroundAssets)[number]["id"];
export type BackgroundManifest = (typeof backgroundAssets)[number];

export type LoadedLandscape = {
  id: LandscapeId;
  scene: THREE.Object3D;
};

/** Load one standalone landscape model without loading the rest of the catalog. */
export async function loadLandscape(loader: GLTFLoader, id: LandscapeId): Promise<LoadedLandscape> {
  const manifest = landscapeAssets.find((candidate) => candidate.id === id);
  if (!manifest) throw new Error(`No landscape asset is registered for ${id}`);
  const { scene } = await loader.loadAsync(manifest.assetUrl);
  return { id, scene };
}
