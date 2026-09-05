import type * as THREE from "three";
import type { DisposedObjectResources } from "./resources";

export type SceneNavigationType = "navigate" | "push" | "replace" | "traverse" | "scene-mount";

export type SceneNavigationStart = {
  id: string;
  url: string;
  startTime: number;
  type: SceneNavigationType;
  claimed?: boolean;
};

export type ScenePerformanceReport = {
  version: 1;
  event: "load" | "runtime" | "dispose" | "error";
  release?: string;
  scene: string;
  path: string;
  navigation: { id: string; type: SceneNavigationType; startTime: number };
  milestones: {
    firstRenderedFrameMs?: number;
    playableCharacterMs?: number;
    phasesMs: Record<string, number>;
  };
  network: {
    requests: number;
    networkRequests: number;
    cacheHits: number;
    unknownCacheStatus: number;
    transferBytes: number;
    encodedBodyBytes: number;
    decodedBodyBytes: number;
  };
  runtime: {
    sampleWindowMs: number;
    frames: number;
    fps?: number;
    p50FrameMs?: number;
    p95FrameMs?: number;
    longestFrameMs?: number;
    p95FrameIntervalMs?: number;
    longestFrameIntervalMs?: number;
    longTasks: number;
    longTaskDurationMs: number;
    drawCalls?: number;
    drawCallsP95?: number;
    drawCallsMax?: number;
    triangles?: number;
    geometries?: number;
    textures?: number;
    programs?: number;
    reactCommits?: number;
    reactCommitDurationMs?: number;
    reactMaxCommitMs?: number;
  };
  renderables: SceneRuntimeStats;
  lifecycle: {
    disposedGeometries: number;
    disposedMaterials: number;
    disposedTextures: number;
  };
  device: {
    tier: "high" | "standard" | "low";
    mobile: boolean;
    devicePixelRatio: number;
    hardwareConcurrency: number;
    deviceMemoryGb?: number;
    webglVersion: string;
    gpu?: string;
    maxTextureSize?: number;
  };
  error?: string;
};

export type SceneRuntimeStats = {
  meshes: number;
  visibleMeshes: number;
  frustumCulledMeshes: number;
  materials: number;
  instancedMeshes: number;
  instances: number;
  foliageMeshes: number;
  foliageInstances: number;
  fenceMeshes: number;
  fenceInstances: number;
  repeatedGeometryGroups: number;
  repeatedGeometryInstances: number;
};

const FOLIAGE_PATTERN = /foliage|tree|grass|plant|shrub|bush|palm/i;
const FENCE_PATTERN = /fence|gate|perimeter|wall-boundary/i;

/** Collect low-cost scene-graph signals that explain GPU pressure in reports. */
export function collectSceneRuntimeStats(root: THREE.Object3D): SceneRuntimeStats {
  const materials = new Set<THREE.Material>();
  const geometryUses = new Map<string, number>();
  const stats: SceneRuntimeStats = {
    meshes: 0,
    visibleMeshes: 0,
    frustumCulledMeshes: 0,
    materials: 0,
    instancedMeshes: 0,
    instances: 0,
    foliageMeshes: 0,
    foliageInstances: 0,
    fenceMeshes: 0,
    fenceInstances: 0,
    repeatedGeometryGroups: 0,
    repeatedGeometryInstances: 0,
  };

  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    const mesh = object as THREE.Mesh & {
      isInstancedMesh?: boolean;
      count?: number;
    };
    const instanceCount = mesh.isInstancedMesh ? Math.max(mesh.count ?? 0, 0) : 1;
    const ancestry = [object.name];
    let parent = object.parent;
    while (parent) {
      ancestry.push(parent.name);
      parent = parent.parent;
    }
    const roleName = ancestry.join(" ");
    const objectMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    objectMaterials.forEach((material) => material && materials.add(material));
    const geometryKey = mesh.geometry?.uuid;
    if (geometryKey)
      geometryUses.set(geometryKey, (geometryUses.get(geometryKey) ?? 0) + instanceCount);

    stats.meshes += 1;
    stats.visibleMeshes += object.visible ? 1 : 0;
    stats.frustumCulledMeshes += mesh.frustumCulled ? 1 : 0;
    stats.instances += instanceCount;
    if (mesh.isInstancedMesh) stats.instancedMeshes += 1;
    if (FOLIAGE_PATTERN.test(roleName)) {
      stats.foliageMeshes += 1;
      stats.foliageInstances += instanceCount;
    }
    if (FENCE_PATTERN.test(roleName)) {
      stats.fenceMeshes += 1;
      stats.fenceInstances += instanceCount;
    }
  });

  stats.materials = materials.size;
  for (const instances of geometryUses.values()) {
    if (instances <= 1) continue;
    stats.repeatedGeometryGroups += 1;
    stats.repeatedGeometryInstances += instances;
  }
  return stats;
}

type ScenePerformanceWindow = Window & {
  __AGENT_HQ_NAVIGATION_START__?: SceneNavigationStart;
  __AGENT_HQ_SCENE_PERF__?: ScenePerformanceReport[];
  __AGENT_HQ_SCENE_TELEMETRY_ENDPOINT__?: string;
  __AGENT_HQ_RELEASE__?: string;
  __AGENT_HQ_REACT_PROFILE__?: Array<{
    id: string;
    phase: "mount" | "update";
    actualDurationMs: number;
    baseDurationMs: number;
    startTime: number;
    commitTime: number;
  }>;
};

const HISTORY_LIMIT = 30;
const RUNTIME_SAMPLE_MS = 5_000;
const RUNTIME_MAX_SAMPLE_MS = 15_000;
const RUNTIME_MIN_FRAMES = 20;

function currentNavigationStart(): SceneNavigationStart {
  const target = window as ScenePerformanceWindow;
  const pending = target.__AGENT_HQ_NAVIGATION_START__;
  if (
    pending &&
    !pending.claimed &&
    new URL(pending.url, window.location.href).pathname === window.location.pathname
  ) {
    return pending;
  }
  return {
    id: `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: window.location.href,
    startTime: performance.now(),
    type: "scene-mount",
    claimed: true,
  };
}

function percentile(sorted: readonly number[], fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function round(value: number | undefined, digits = 1): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function networkSnapshot(startTime: number): ScenePerformanceReport["network"] {
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  let networkRequests = 0;
  let cacheHits = 0;
  let unknownCacheStatus = 0;
  let transferBytes = 0;
  let encodedBodyBytes = 0;
  let decodedBodyBytes = 0;
  const assets = entries.filter((entry) => {
    if (entry.startTime < startTime) return false;
    const url = new URL(entry.name, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/assets/");
  });
  for (const entry of assets) {
    transferBytes += entry.transferSize;
    encodedBodyBytes += entry.encodedBodySize;
    decodedBodyBytes += entry.decodedBodySize;
    if (entry.transferSize > 0) networkRequests += 1;
    else if (entry.decodedBodySize > 0) cacheHits += 1;
    else unknownCacheStatus += 1;
  }
  return {
    requests: assets.length,
    networkRequests,
    cacheHits,
    unknownCacheStatus,
    transferBytes,
    encodedBodyBytes,
    decodedBodyBytes,
  };
}

function deviceSnapshot(
  renderer: THREE.WebGLRenderer,
  tier: "high" | "standard" | "low"
): ScenePerformanceReport["device"] {
  const gl = renderer.getContext();
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info") as {
    UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const gpu = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : undefined;
  return {
    tier,
    mobile: /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent),
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    webglVersion: renderer.capabilities.isWebGL2 ? "webgl2" : "webgl1",
    gpu,
    maxTextureSize: renderer.capabilities.maxTextureSize,
  };
}

function reactProfileSnapshot(startTime: number): {
  commits: number;
  durationMs: number;
  maxDurationMs: number;
} {
  const entries = (window as ScenePerformanceWindow).__AGENT_HQ_REACT_PROFILE__ ?? [];
  const relevant = entries.filter((entry) => entry.commitTime >= startTime);
  return {
    commits: relevant.length,
    durationMs: relevant.reduce((total, entry) => total + entry.actualDurationMs, 0),
    maxDurationMs: Math.max(0, ...relevant.map((entry) => entry.actualDurationMs)),
  };
}

function publish(report: ScenePerformanceReport): void {
  const target = window as ScenePerformanceWindow;
  const history = target.__AGENT_HQ_SCENE_PERF__ ?? [];
  history.push(report);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  target.__AGENT_HQ_SCENE_PERF__ = history;
  window.dispatchEvent(
    new CustomEvent<ScenePerformanceReport>("agent-hq:scene-performance", { detail: report })
  );
  if (new URLSearchParams(window.location.search).has("debug")) {
    console.info(`[Agent HQ] scene performance ${JSON.stringify(report)}`);
  }

  const endpoint = target.__AGENT_HQ_SCENE_TELEMETRY_ENDPOINT__;
  if (!endpoint) return;
  const body = JSON.stringify(report);
  if (!navigator.sendBeacon?.(endpoint, new Blob([body], { type: "application/json" }))) {
    void fetch(endpoint, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      keepalive: true,
    }).catch(() => undefined);
  }
}

export type ScenePerformanceTelemetry = {
  track<T>(phase: string, promise: Promise<T>): Promise<T>;
  mark(phase: string): void;
  markPlayable(): void;
  recordFrame(workDurationMs: number, drawCalls?: number): void;
  recordDisposedResources(resources: DisposedObjectResources): void;
  fail(cause: unknown): void;
  dispose(): void;
};

export function createScenePerformanceTelemetry(
  scene: string,
  renderer: THREE.WebGLRenderer,
  tier: "high" | "standard" | "low",
  root: THREE.Object3D
): ScenePerformanceTelemetry {
  const navigation = currentNavigationStart();
  const startedAt = navigation.startTime;
  const phaseStarts = new Map<string, number>();
  const phasesMs: Record<string, number> = {};
  const frameDurations: number[] = [];
  const frameIntervals: number[] = [];
  const frameDrawCalls: number[] = [];
  const createdAt = performance.now();
  let previousFrameAt: number | undefined;
  let firstRenderedFrameAt: number | undefined;
  let playableAt: number | undefined;
  let runtimeSampleStartedAt: number | undefined;
  let runtimePublished = false;
  let disposed = false;
  let longTasks = 0;
  let longTaskDurationMs = 0;
  const disposedResources: DisposedObjectResources = {
    geometries: 0,
    materials: 0,
    textures: 0,
  };

  let longTaskObserver: PerformanceObserver | undefined;
  if (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < startedAt) continue;
        longTasks += 1;
        longTaskDurationMs += entry.duration;
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  }

  const report = (
    event: ScenePerformanceReport["event"],
    error?: string
  ): ScenePerformanceReport => {
    const now = performance.now();
    const sortedFrames = [...frameDurations].sort((a, b) => a - b);
    const sortedIntervals = [...frameIntervals].sort((a, b) => a - b);
    const sortedDrawCalls = [...frameDrawCalls].sort((a, b) => a - b);
    const reactProfile = reactProfileSnapshot(startedAt);
    const sampleWindowMs = Math.max(
      0,
      now - (runtimeSampleStartedAt ?? firstRenderedFrameAt ?? createdAt)
    );
    const info = renderer.info;
    return {
      version: 1,
      event,
      release: (window as ScenePerformanceWindow).__AGENT_HQ_RELEASE__,
      scene,
      path: window.location.pathname,
      navigation: { id: navigation.id, type: navigation.type, startTime: navigation.startTime },
      milestones: {
        firstRenderedFrameMs: round(
          firstRenderedFrameAt == null ? undefined : firstRenderedFrameAt - startedAt
        ),
        playableCharacterMs: round(playableAt == null ? undefined : playableAt - startedAt),
        phasesMs: { ...phasesMs },
      },
      network: networkSnapshot(startedAt),
      runtime: {
        sampleWindowMs: round(sampleWindowMs) ?? 0,
        frames: frameDurations.length,
        fps:
          frameDurations.length > 0 && sampleWindowMs > 0
            ? round((frameDurations.length * 1000) / sampleWindowMs)
            : undefined,
        p50FrameMs: round(percentile(sortedFrames, 0.5)),
        p95FrameMs: round(percentile(sortedFrames, 0.95)),
        longestFrameMs: round(sortedFrames.at(-1)),
        p95FrameIntervalMs: round(percentile(sortedIntervals, 0.95)),
        longestFrameIntervalMs: round(sortedIntervals.at(-1)),
        longTasks,
        longTaskDurationMs: round(longTaskDurationMs) ?? 0,
        drawCalls: info.render.calls,
        drawCallsP95: round(percentile(sortedDrawCalls, 0.95)),
        drawCallsMax: round(sortedDrawCalls.at(-1), 0),
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length,
        reactCommits: reactProfile.commits,
        reactCommitDurationMs: round(reactProfile.durationMs),
        reactMaxCommitMs: round(reactProfile.maxDurationMs),
      },
      renderables: collectSceneRuntimeStats(root),
      lifecycle: {
        disposedGeometries: disposedResources.geometries,
        disposedMaterials: disposedResources.materials,
        disposedTextures: disposedResources.textures,
      },
      device: deviceSnapshot(renderer, tier),
      error,
    };
  };

  const mark = (phase: string) => {
    const phaseStart = phaseStarts.get(phase) ?? createdAt;
    phasesMs[phase] = round(performance.now() - phaseStart) ?? 0;
  };

  return {
    track<T>(phase: string, promise: Promise<T>): Promise<T> {
      phaseStarts.set(phase, performance.now());
      const tracked = promise.finally(() => mark(phase));
      // Loading promises can outlive a scene when React remounts it after a
      // character switch. Attach a rejection handler immediately so an
      // aborted optional request cannot become an unhandled browser error
      // before the main loader reaches its Promise.all boundary.
      tracked.catch(() => undefined);
      return tracked;
    },
    mark,
    markPlayable() {
      if (playableAt != null) return;
      playableAt = performance.now();
      // Loading and shader compilation can block the first few animation
      // frames for seconds. Start a clean post-playable sample so p95 is a
      // runtime signal instead of the maximum of one or two loading stalls.
      frameDurations.length = 0;
      frameIntervals.length = 0;
      frameDrawCalls.length = 0;
      longTasks = 0;
      longTaskDurationMs = 0;
      previousFrameAt = undefined;
      runtimeSampleStartedAt = undefined;
    },
    recordFrame(workDurationMs, drawCalls) {
      if (disposed) return;
      const now = performance.now();
      if (drawCalls != null && Number.isFinite(drawCalls)) frameDrawCalls.push(drawCalls);
      if (firstRenderedFrameAt == null) {
        firstRenderedFrameAt = now;
        previousFrameAt = now;
        navigation.claimed = true;
        publish(report("load"));
        return;
      }
      if (playableAt == null) return;
      runtimeSampleStartedAt ??= now;
      if (previousFrameAt != null) frameIntervals.push(now - previousFrameAt);
      frameDurations.push(workDurationMs);
      previousFrameAt = now;
      if (
        !runtimePublished &&
        now - runtimeSampleStartedAt >= RUNTIME_SAMPLE_MS &&
        (frameDurations.length >= RUNTIME_MIN_FRAMES ||
          now - runtimeSampleStartedAt >= RUNTIME_MAX_SAMPLE_MS)
      ) {
        runtimePublished = true;
        publish(report("runtime"));
      }
    },
    recordDisposedResources(resources) {
      disposedResources.geometries += resources.geometries;
      disposedResources.materials += resources.materials;
      disposedResources.textures += resources.textures;
    },
    fail(cause) {
      navigation.claimed = true;
      publish(report("error", cause instanceof Error ? cause.message : String(cause)));
    },
    dispose() {
      disposed = true;
      longTaskObserver?.disconnect();
      if (
        disposedResources.geometries + disposedResources.materials + disposedResources.textures >
        0
      ) {
        publish(report("dispose"));
      } else if (!runtimePublished && firstRenderedFrameAt != null && frameDurations.length > 0) {
        runtimePublished = true;
        publish(report("runtime"));
      }
    },
  };
}
