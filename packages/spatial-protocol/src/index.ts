export type { SceneManifest, SceneStartPosition, SceneZone } from '@adea-ai/asset-manifests'
export {
  agentSimEngineManifestUrl,
  isLocalDevHost,
  isOfficialAgentSimWebOrigin,
  parseAgentSimEngineManifest,
  OFFICIAL_AGENT_SIM_WEB_HOSTS,
  type AgentSimEngineManifest,
} from './engine'
export { hqHomeManifest, hqWorkManifest } from './manifests'
export {
  appRouteHref,
  encodeSceneStartPosition,
  portalNavigationHref,
  readSceneStartPosition,
  type PortalNavigation,
  type SceneApp,
} from './scene-spawn'
export {
  createSceneTelemetryEnvelope,
  MAX_SCENE_TELEMETRY_BYTES,
  onRouterTransitionStart,
  parseScenePerformanceReport,
  recordNavigation,
  SCENE_TELEMETRY_LOG_PREFIX,
  type SceneNavigationType,
  type ScenePerformanceReport,
  type SceneRuntimeStats,
  type SceneTelemetryEnvelope,
} from './telemetry'
export const configurableCharacterId = 'configurable'
export const DEFAULT_CHARACTER_ID = configurableCharacterId

/**
 * Shell-side character param check. The engine validates against its
 * reference/preset catalogs on mount; the shell only needs a plausible
 * non-empty value to thread through.
 */
export function isPlausibleCharacterId(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
