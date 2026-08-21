import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadPlacedFieldFromCatalog } from "@agent-hq/placed-models";
import { propAssets } from "./index.js";

/** Build one InstancedMesh per prop catalog model from a placement manifest.
 *
 * Thin wrapper over @agent-hq/placed-models' catalog-bound field loader, bound to
 * the @agent-hq/props catalog. Scenes that strip their embedded props (see
 * scripts/extract-props.mjs) instance the shared models at runtime instead.
 */
export async function loadPropsField(loader: GLTFLoader, manifestUrl: string) {
  return loadPlacedFieldFromCatalog(loader, manifestUrl, propAssets, "props-field");
}
