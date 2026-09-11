import { createFileRoute } from '@tanstack/react-router'
import { withRequestScope } from '../../../../server/request-scope'
import {
  createSceneTelemetryEnvelope,
  MAX_SCENE_TELEMETRY_BYTES,
  parseScenePerformanceReport,
  SCENE_TELEMETRY_LOG_PREFIX,
} from '@adea-ai/spatial-protocol'
async function post(request: Request): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_SCENE_TELEMETRY_BYTES)
    return Response.json({ error: 'payload_too_large' }, { status: 413 })
  const requestUrl = new URL(request.url)
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  if (
    (fetchSite && fetchSite !== 'same-origin') ||
    (!fetchSite && origin && origin !== requestUrl.origin)
  ) {
    return Response.json({ error: 'origin_not_allowed' }, { status: 403 })
  }
  let text: string
  try {
    text = await request.text()
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 })
  }
  if (new TextEncoder().encode(text).byteLength > MAX_SCENE_TELEMETRY_BYTES)
    return Response.json({ error: 'payload_too_large' }, { status: 413 })
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const report = parseScenePerformanceReport(value)
  if (!report) return Response.json({ error: 'invalid_report' }, { status: 422 })
  console.info(
    `${SCENE_TELEMETRY_LOG_PREFIX}${JSON.stringify(createSceneTelemetryEnvelope(report))}`
  )
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}
export const Route = createFileRoute('/api/telemetry/scene-performance')({
  server: {
    handlers: {
      POST: ({ request }) => withRequestScope(() => post(request)),
    },
  },
})
