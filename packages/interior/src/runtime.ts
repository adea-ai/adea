import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadSceneFieldFromCatalog } from "@agent-hq/scene-fields";
import { propAssets } from "./catalog.js";
import type { LoadedProp, PropId } from "./prop-types.js";

export async function loadProp(loader: GLTFLoader, id: PropId): Promise<LoadedProp> {
  const manifest = propAssets.find((candidate) => candidate.id === id);
  if (!manifest) throw new Error(`No interior prop asset is registered for ${id}`);
  const { scene } = await loader.loadAsync(manifest.assetUrl);
  return { id, scene };
}

/** Build one InstancedMesh per prop catalog model from a scene-field manifest.
 *
 * Thin wrapper over @agent-hq/scene-fields' catalog-bound field loader, bound to
 * the @agent-hq/interior catalog. Scenes that strip their embedded props (see
 * scripts/extract-props.mjs) instance the shared models at runtime instead.
 */
export async function loadPropsField(
  loader: GLTFLoader,
  manifestUrl: string,
  signal?: AbortSignal
) {
  return loadSceneFieldFromCatalog(loader, manifestUrl, propAssets, "props-field", signal);
}
