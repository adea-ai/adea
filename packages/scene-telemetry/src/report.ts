import type { ScenePerformanceReport } from "@agent-hq/scene-runtime";

export const SCENE_TELEMETRY_LOG_PREFIX = "[scene-telemetry] ";
export const MAX_SCENE_TELEMETRY_BYTES = 64 * 1024;

export type SceneTelemetryEnvelope = {
  receivedAt: string;
  deployment?: string;
  report: ScenePerformanceReport;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validReport(value: unknown): value is ScenePerformanceReport {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || !["load", "runtime", "error"].includes(String(value.event)))
    return false;
  if (typeof value.scene !== "string" || value.scene.length < 1 || value.scene.length > 80)
    return false;
  if (typeof value.path !== "string" || value.path.length < 1 || value.path.length > 256)
    return false;
  if (value.release != null && (typeof value.release !== "string" || value.release.length > 128))
    return false;
  if (
    !isRecord(value.navigation) ||
    typeof value.navigation.id !== "string" ||
    !isFiniteNumber(value.navigation.startTime)
  )
    return false;
  if (!isRecord(value.milestones) || !isRecord(value.milestones.phasesMs)) return false;
  if (
    !isRecord(value.network) ||
    !isFiniteNumber(value.network.requests) ||
    !isFiniteNumber(value.network.transferBytes)
  )
    return false;
  if (
    !isRecord(value.runtime) ||
    !isFiniteNumber(value.runtime.sampleWindowMs) ||
    !isFiniteNumber(value.runtime.frames)
  )
    return false;
  if (!isRecord(value.device) || !["high", "standard", "low"].includes(String(value.device.tier)))
    return false;
  if (typeof value.device.mobile !== "boolean" || !isFiniteNumber(value.device.devicePixelRatio))
    return false;
  return true;
}

export function parseScenePerformanceReport(value: unknown): ScenePerformanceReport | null {
  return validReport(value) ? value : null;
}

export function createSceneTelemetryEnvelope(
  report: ScenePerformanceReport,
  receivedAt = new Date(),
  deployment = process.env.VERCEL_GIT_COMMIT_SHA,
): SceneTelemetryEnvelope {
  return {
    receivedAt: receivedAt.toISOString(),
    ...(deployment ? { deployment } : {}),
    report,
  };
}
