import type { WorkspaceSceneId } from '@agent-hq/types'

export type HqSceneId = WorkspaceSceneId

export function hqSceneFromSearchParams(params: { scene?: string | string[] }): HqSceneId {
  const scene = Array.isArray(params.scene) ? params.scene[0] : params.scene
  return scene === 'work' ? 'work' : 'home'
}
