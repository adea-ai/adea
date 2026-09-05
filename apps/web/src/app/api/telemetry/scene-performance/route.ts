import { NextResponse } from "next/server";
import {
  createSceneTelemetryEnvelope,
  MAX_SCENE_TELEMETRY_BYTES,
  parseScenePerformanceReport,
  SCENE_TELEMETRY_LOG_PREFIX,
} from "@agent-hq/scene-telemetry";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_SCENE_TELEMETRY_BYTES)
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    (fetchSite && fetchSite !== "same-origin") ||
    (!fetchSite && origin && origin !== requestUrl.origin)
  ) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (new TextEncoder().encode(text).byteLength > MAX_SCENE_TELEMETRY_BYTES)
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const report = parseScenePerformanceReport(value);
  if (!report) return NextResponse.json({ error: "invalid_report" }, { status: 422 });
  console.info(
    `${SCENE_TELEMETRY_LOG_PREFIX}${JSON.stringify(createSceneTelemetryEnvelope(report))}`
  );
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
