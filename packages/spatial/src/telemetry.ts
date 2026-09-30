export type SceneNavigationType = 'navigate' | 'push' | 'replace' | 'traverse' | 'scene-mount'

export type ScenePerformanceReport = {
  version: 1
  event: 'load' | 'runtime' | 'dispose' | 'error'
  release?: string
  scene: string
  path: string
  navigation: { id: string; type: SceneNavigationType; startTime: number }
  milestones: {
    firstRenderedFrameMs?: number
    playableCharacterMs?: number
    phasesMs: Record<string, number>
  }
  network: {
    requests: number
    networkRequests: number
    cacheHits: number
    unknownCacheStatus: number
    transferBytes: number
    encodedBodyBytes: number
    decodedBodyBytes: number
  }
  runtime: {
    sampleWindowMs: number
    frames: number
    fps?: number
    p50FrameMs?: number
    p95FrameMs?: number
    longestFrameMs?: number
    p95FrameIntervalMs?: number
    longestFrameIntervalMs?: number
    longTasks: number
    longTaskDurationMs: number
    drawCalls?: number
    drawCallsP95?: number
    drawCallsMax?: number
    triangles?: number
    geometries?: number
    textures?: number
    programs?: number
    reactCommits?: number
    reactCommitDurationMs?: number
    reactMaxCommitMs?: number
  }
  renderables: SceneRuntimeStats
  lifecycle: {
    disposedGeometries: number
    disposedMaterials: number
    disposedTextures: number
  }
  device: {
    tier: 'high' | 'standard' | 'low'
    mobile: boolean
    devicePixelRatio: number
    hardwareConcurrency: number
    deviceMemoryGb?: number
    webglVersion: string
    gpu?: string
    maxTextureSize?: number
  }
  error?: string
}

export type SceneRuntimeStats = {
  meshes: number
  visibleMeshes: number
  frustumCulledMeshes: number
  materials: number
  instancedMeshes: number
  instances: number
  foliageMeshes: number
  foliageInstances: number
  fenceMeshes: number
  fenceInstances: number
  repeatedGeometryGroups: number
  repeatedGeometryInstances: number
}

export const SCENE_TELEMETRY_LOG_PREFIX = '[scene-telemetry] '
export const MAX_SCENE_TELEMETRY_BYTES = 64 * 1024

export type SceneTelemetryEnvelope = {
  receivedAt: string
  deployment?: string
  report: ScenePerformanceReport
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validReport(value: unknown): value is ScenePerformanceReport {
  if (!isRecord(value)) return false
  if (value.version !== 1 || !['load', 'runtime', 'dispose', 'error'].includes(String(value.event)))
    return false
  if (typeof value.scene !== 'string' || value.scene.length < 1 || value.scene.length > 80)
    return false
  if (typeof value.path !== 'string' || value.path.length < 1 || value.path.length > 256)
    return false
  if (value.release != null && (typeof value.release !== 'string' || value.release.length > 128))
    return false
  if (
    !isRecord(value.navigation) ||
    typeof value.navigation.id !== 'string' ||
    !isFiniteNumber(value.navigation.startTime)
  )
    return false
  if (!isRecord(value.milestones) || !isRecord(value.milestones.phasesMs)) return false
  if (
    !isRecord(value.network) ||
    !isFiniteNumber(value.network.requests) ||
    !isFiniteNumber(value.network.transferBytes)
  )
    return false
  if (
    !isRecord(value.runtime) ||
    !isFiniteNumber(value.runtime.sampleWindowMs) ||
    !isFiniteNumber(value.runtime.frames)
  )
    return false
  if (!isRecord(value.device) || !['high', 'standard', 'low'].includes(String(value.device.tier)))
    return false
  if (typeof value.device.mobile !== 'boolean' || !isFiniteNumber(value.device.devicePixelRatio))
    return false
  return true
}

export function parseScenePerformanceReport(value: unknown): ScenePerformanceReport | null {
  return validReport(value) ? value : null
}

export function createSceneTelemetryEnvelope(
  report: ScenePerformanceReport,
  receivedAt = new Date(),
  deployment = process.env.DEPLOY_GIT_COMMIT_SHA
): SceneTelemetryEnvelope {
  return {
    receivedAt: receivedAt.toISOString(),
    ...(deployment ? { deployment } : {}),
    report,
  }
}

type NavigationStart = {
  id: string
  url: string
  startTime: number
  type: 'navigate' | 'push' | 'replace' | 'traverse'
  claimed?: boolean
}

declare global {
  interface Window {
    __ADEA_NAVIGATION_START__?: NavigationStart
    __ADEA_SCENE_TELEMETRY_ENDPOINT__?: string
    __ADEA_RELEASE__?: string
  }
}

export function recordNavigation(
  url: string,
  type: 'navigate' | 'push' | 'replace' | 'traverse',
  startTime: number
): void {
  window.__ADEA_NAVIGATION_START__ = {
    id: `nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    startTime,
    type,
  }
}

try {
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
  recordNavigation(window.location.href, 'navigate', navigation?.startTime ?? 0)
  const endpoint =
    process.env.ADEA_PUBLIC_SCENE_TELEMETRY_ENDPOINT ||
    (process.env.NODE_ENV === 'production' ? '/api/telemetry/scene-performance' : undefined)
  if (endpoint) window.__ADEA_SCENE_TELEMETRY_ENDPOINT__ = endpoint
  const release = process.env.ADEA_PUBLIC_DEPLOY_GIT_COMMIT_SHA
  if (release) window.__ADEA_RELEASE__ = release
} catch {
  // Telemetry must never interfere with page initialization.
}

export function onRouterTransitionStart(
  url: string,
  navigationType: 'push' | 'replace' | 'traverse'
): void {
  try {
    recordNavigation(new URL(url, window.location.href).href, navigationType, performance.now())
  } catch {
    // Invalid route metadata should not affect navigation.
  }
}
