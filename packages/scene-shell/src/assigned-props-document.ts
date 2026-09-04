import type { AssignedPropsManifest } from '@agent-hq/asset-manifests'

const documentCache = new Map<string, Promise<AssignedPropsManifest>>()

/**
 * Loads the runtime-only manifest for props assigned to a scene. Unlike the
 * room designer document, this response contains only the placed asset data
 * needed by the normal HQ scene.
 */
export function loadAssignedPropsManifest(url: string): Promise<AssignedPropsManifest> {
  const cached = documentCache.get(url)
  if (cached) return cached

  const request = fetch(url, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) return { assets: {}, placements: {} }
      const value = (await response.json()) as Partial<AssignedPropsManifest>
      return {
        version: value.version,
        scene: value.scene,
        assets: value.assets ?? {},
        placements: value.placements ?? {},
      }
    })
    .catch((error: unknown) => {
      documentCache.delete(url)
      throw error
    })

  documentCache.set(url, request)
  return request
}

export function invalidateAssignedPropsManifest(url: string): void {
  documentCache.delete(url)
}
