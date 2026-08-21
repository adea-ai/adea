import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadPlacedFieldFromCatalog } from "@agent-hq/placed-models";
import { cityArtVehicleAssets } from "./index.js";

/** Build one InstancedMesh per city vehicle catalog model from a placement
 *  manifest.
 *
 * Thin wrapper over @agent-hq/placed-models' catalog-bound field loader, bound to
 * the @agent-hq/vehicles city catalog. Scenes that strip parked vehicles (see
 * scripts/extract-vehicles.mjs) instance the shared models at runtime.
 */
export async function loadPlacedVehicles(loader: GLTFLoader, manifestUrl: string) {
  return loadPlacedFieldFromCatalog(loader, manifestUrl, cityArtVehicleAssets, "vehicles-field");
}
