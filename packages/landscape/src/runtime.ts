import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadPlacedFieldFromCatalog } from "@agent-hq/placed-models";
import { landscapeAssets } from "./index.js";

/** Build one InstancedMesh per landscape catalog model from a placement
 *  manifest.
 *
 * Thin wrapper over @agent-hq/placed-models' catalog-bound field loader, bound to
 * the @agent-hq/landscape catalog (foliage, geology, water). Scenes that strip
 * their embedded copies (see scripts/extract-foliage.mjs) instance the shared
 * models at runtime instead.
 */
export async function loadLandscapeField(loader: GLTFLoader, manifestUrl: string) {
  return loadPlacedFieldFromCatalog(loader, manifestUrl, landscapeAssets, "landscape-field");
}
