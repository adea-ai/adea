import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadPlacedFieldFromCatalog } from "@agent-hq/placed-models";
import { buildingAssets } from "./index.js";

/** Build one InstancedMesh per building model from a placement manifest.
 *
 * Thin wrapper over the shared placed-models field loader bound to the
 * @agent-hq/buildings catalog. Unique buildings (single placement) load as plain
 * meshes (on-demand); genuinely repeated blocks render as InstancedMesh.
 */
export async function loadBuildingsField(loader: GLTFLoader, manifestUrl: string) {
  return loadPlacedFieldFromCatalog(loader, manifestUrl, buildingAssets, "buildings-field");
}
