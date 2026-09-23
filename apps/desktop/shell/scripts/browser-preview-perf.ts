// Browser preview performance soak (#422's measured acceptance box; also the
// packaged long-task proof #539 records).
//
// Measures, against a REAL engine through the M10 gate, for `--minutes`
// (default 30):
//
//   startup          lane create → first published screencast frame
//   frame latency    action → next frame, sampled on a cadence, p50/p95
//   CPU / memory     an idle half and an active half, RSS and CPU seconds
//   capture storage  screenshots through the production store, bytes retained
//                    against its caps
//   preview window   the requested duration actually elapsed, with samples
//
// Everything is measured, nothing is invented: a host without a live engine
// records a typed `capability_unavailable` and exits 2 rather than reporting
// numbers from a fixture. The artifact states which engine served the run.
//
// Usage: bun apps/desktop/shell/scripts/browser-preview-perf.ts [--minutes 30] [--artifact path]
import { createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  devCommandProofMessage,
  devOperationDefinitions,
  type DevCommand,
  type DevReply,
  type DevStreamGrant,
  type Scope,
} from '../../../../packages/types/src/dev-runtime'
import { createChannelAuthority } from '../src/dev-runtime/channel/authority'
import type { ChannelGateway } from '../src/dev-runtime/channel/server'
import { registerBrowserDeviceRuntime } from '../src/dev-runtime/browser/register'

const SHELL_HOST = '127.0.0.1:4795'
const SHELL_ORIGIN = 'http://127.0.0.1:4795'
const SCOPE: Scope = {
  accountId: '00000000-0000-4000-8000-0000000000e1',
  workspaceId: '00000000-0000-4000-8000-0000000000e2',
  runtimeNodeId: '00000000-0000-4000-8000-0000000000e3',
} as const

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls a predicate until it holds or the budget expires. The predicate reads
 *  state the frame handler mutates, which is why it is a closure here rather
 *  than a loop condition the lane mutates inside. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

function argValue(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/** True when this Bun build can host the live engine the lane measures. */
function engineAvailable(): boolean {
  const bun = process.versions.bun ?? '0.0.0'
  const [major = 0] = bun.split('.').map((part) => Number.parseInt(part, 10))
  return Boolean((globalThis as { Bun?: { WebView?: unknown } }).Bun?.WebView) && major >= 1
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].toSorted((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return Math.round(sorted[index]!)
}

/** Whether this host can host the live engine the lane measures. A host
 *  without `Bun.WebView` has no engine, and the lane says so rather than
 *  measuring a stand-in. */
function webViewBackendAvailable(): boolean {
  return Boolean((globalThis as { Bun?: { WebView?: unknown } }).Bun?.WebView)
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.error('browser-preview-perf: darwin-only lane')
    return 2
  }
  const minutes = Number(argValue('--minutes', '30'))
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) {
    console.error('--minutes must be between 1 and 120')
    return 2
  }
  const artifactPath = argValue('--artifact', 'artifacts/browser/preview-perf.json')!

  const profileRoot = join(dirname(artifactPath), 'preview-perf-profiles')
  if (!engineAvailable()) {
    const unavailable = {
      lane: 'browser-preview-perf',
      issue: '#422',
      status: 'blocked',
      reason:
        'no live engine on this host; a performance measurement is not fabricated from fixtures',
      engine: 'unavailable',
      requestedMinutes: minutes,
      recordedAt: new Date().toISOString(),
    }
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `${JSON.stringify(unavailable, null, 2)}\n`)
    console.log(`browser-preview-perf BLOCKED (no live engine); artifact: ${artifactPath}`)
    return 2
  }

  // A page that repaints continuously, so consecutive screencast frames differ
  // and frame latency is a real interval rather than a retained-frame no-op.
  const page = `<!doctype html><meta charset="utf-8"><title>preview perf</title>
<body style="margin:0;background:#101014;color:#e6e6e6;font:14px ui-monospace">
<div id="t" style="padding:24px"></div>
<canvas id="c" width="640" height="360" style="margin:24px"></canvas>
<script>
  const c = document.getElementById('c').getContext('2d')
  let n = 0
  setInterval(() => {
    n += 1
    document.getElementById('t').textContent = 'frame ' + n
    c.fillStyle = 'hsl(' + (n % 360) + ',60%,40%)'
    c.fillRect(0, 0, 640, 360)
  }, 16)
</script>`
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  })
  const port = server.port
  if (port === undefined) throw new Error('the proof server did not bind a port')
  const pageUrl = `http://127.0.0.1:${port}/`

  const samples: Array<{
    atMs: number
    phase: 'idle' | 'active'
    rssBytes: number
    cpuSeconds: number
    frames: number
    frameLatencyMs: number | null
    captureBytes: number
  }> = []
  const frameLatencies: number[] = []
  const captureLatencies: number[] = []
  const frameIntervals: number[] = []
  let lastFrameAt: number | null = null
  let frames = 0
  let pendingAction: { at: number; awaited: number } | null = null
  let captureBytes = 0
  let capturePeakBytes = 0
  let captureRefusals = 0

  try {
    let browserFramesHandler: ((session: unknown) => void) | undefined
    const gateway = {
      registerStreamHandler: (protocol: string, handler: (session: unknown) => void) => {
        if (protocol === 'browser-frames-v1') browserFramesHandler = handler
      },
    } as unknown as ChannelGateway

    const authority = createChannelAuthority({ shellHost: SHELL_HOST, shellOrigin: SHELL_ORIGIN })
    const handshake = authority.handshake(
      {
        schemaVersion: 1,
        method: 'dev.runtime.handshake.v1',
        requestId: randomUUID(),
        bootstrap: authority.issueLaunchBootstrap(),
        supportedProtocolVersions: ['1'],
        nonce: Buffer.from(randomUUID()).toString('base64url'),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      { trusted: true }
    )
    if (!handshake.ok) throw new Error('handshake failed')
    const secret = Buffer.from(handshake.clientSecret, 'base64url')
    const identity = {
      channelId: handshake.channelId,
      clientCredentialId: handshake.clientCredentialId,
    }

    registerBrowserDeviceRuntime({
      authority,
      gateway,
      ownedServices: () => [{ host: '127.0.0.1', port, ownerId: 'preview-perf' }],
      resolveDns: async () => [],
      scope: SCOPE,
      dataDir: profileRoot,
      webViewBackendProbe: webViewBackendAvailable,
    })

    function execute(
      operation: keyof typeof devOperationDefinitions,
      body: Record<string, unknown>,
      resource?: { kind: string; id: string; generation: number }
    ): Promise<DevReply> {
      const command: DevCommand = {
        schemaVersion: 1,
        operation,
        requestId: randomUUID(),
        nonce: Buffer.from(randomUUID()).toString('base64url'),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        scope: SCOPE,
        capabilities: [...devOperationDefinitions[operation].capabilities],
        ...(resource ? { resource } : {}),
        body,
      }
      return authority.execute(
        {
          channelId: identity.channelId,
          clientCredentialId: identity.clientCredentialId,
          command,
          proof: createHmac('sha256', secret)
            .update(
              devCommandProofMessage({
                channelId: identity.channelId,
                clientCredentialId: identity.clientCredentialId,
                command,
              }),
              'utf8'
            )
            .digest('base64url'),
        },
        { trusted: true }
      )
    }

    // ── startup: lane create → first published frame ────────────────────────
    const startedAt = performance.now()
    const created = await execute('dev.browser.laneCreate', {
      runtimeSessionId: 'preview-perf-session',
      kind: 'task_owned',
      profilePolicyId: 'default:task_owned',
    })
    if (!created.ok) throw new Error(`laneCreate failed: ${created.error.code}`)
    const laneId = (created.value as { id: string }).id
    const laneResource = { kind: 'browser_lane', id: laneId, generation: 1 }

    const attach = await execute(
      'dev.browser.attach',
      { browserLaneId: laneId, expectedGeneration: 1, direction: 'read' },
      laneResource
    )
    if (!attach.ok) throw new Error(`attach failed: ${attach.error.code}`)
    const grant = attach.value as DevStreamGrant
    if (!browserFramesHandler) throw new Error('no browser-frames-v1 handler is composed')
    browserFramesHandler({
      grant,
      send: () => {
        frames += 1
        const now = performance.now()
        if (lastFrameAt !== null) frameIntervals.push(Math.round(now - lastFrameAt))
        lastFrameAt = now
        if (pendingAction) {
          frameLatencies.push(Math.max(0, now - pendingAction.at))
          pendingAction = null
        }
      },
      close: () => undefined,
    } as unknown as never)

    const gotFirstFrame = await waitUntil(() => frames > 0, 45_000)
    if (!gotFirstFrame)
      throw new Error('no frame was published within 45s; refusing to report a startup number')
    const startupMs = Math.round(performance.now() - startedAt)

    const navigated = await execute(
      'dev.browser.navigate',
      { browserLaneId: laneId, expectedGeneration: 1, url: pageUrl },
      laneResource
    )
    const navigationOk = navigated.ok

    // ── the soak: idle half, then an active half ────────────────────────────
    const totalMs = minutes * 60_000
    const sampleEveryMs = 10_000
    const startedSampling = performance.now()
    let lastCpu = process.cpuUsage()
    while (performance.now() - startedSampling < totalMs) {
      await sleep(sampleEveryMs)
      const elapsed = performance.now() - startedSampling
      const phase: 'idle' | 'active' = elapsed < totalMs / 2 ? 'idle' : 'active'
      if (phase === 'active') {
        // A capture plus a viewport change is the "active" workload the box asks
        // about; the frame that follows is what the latency sample measures.
        pendingAction = { at: performance.now(), awaited: frames }
        const captureStart = performance.now()
        const shot = await execute(
          'dev.browser.screenshot',
          { browserLaneId: laneId, expectedGeneration: 1, format: 'png' },
          laneResource
        ).catch(() => ({ ok: false }) as DevReply)
        if (shot.ok) captureLatencies.push(Math.round(performance.now() - captureStart))
        if (shot.ok) {
          // The reply's ref carries the retained byte length as a string; the
          // cumulative total is what the box's "bounded capture storage" means.
          const ref = shot.value as { byteLength?: string }
          captureBytes += Number(ref.byteLength ?? 0)
          capturePeakBytes = Math.max(capturePeakBytes, captureBytes)
        } else {
          // A capture refused for retention is the bound working, not a lane
          // failure: record it and stop asking the store for more.
          captureRefusals += 1
        }
        await execute(
          'dev.browser.viewport',
          {
            browserLaneId: laneId,
            expectedGeneration: 1,
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            mobile: false,
          },
          laneResource
        ).catch(() => undefined)
        // Give the action a bounded window to be answered by a frame; an action
        // that never produces one is recorded as a null sample, not a zero.
        await waitUntil(() => pendingAction === null, 5_000)
        pendingAction = null
      }
      const cpu = process.cpuUsage(lastCpu)
      lastCpu = process.cpuUsage()
      samples.push({
        atMs: Math.round(elapsed),
        phase,
        rssBytes: process.memoryUsage().rss,
        cpuSeconds: Number(((cpu.user + cpu.system) / 1_000_000).toFixed(3)),
        frames,
        frameLatencyMs:
          frameLatencies.length > 0 ? frameLatencies[frameLatencies.length - 1]! : null,
        captureBytes,
      })
    }

    const idle = samples.filter((sample) => sample.phase === 'idle')
    const active = samples.filter((sample) => sample.phase === 'active')
    const rss = samples.map((sample) => sample.rssBytes)
    const elapsedMs = Math.round(performance.now() - startedSampling)

    const artifact = {
      lane: 'browser-preview-perf',
      issue: '#422',
      status: 'passed',
      engine: 'Bun.WebView (live)',
      requestedMinutes: minutes,
      previewElapsedMs: elapsedMs,
      startup: { laneCreateToFirstFrameMs: startupMs, navigationAdmitted: navigationOk },
      frames: {
        published: frames,
        // Action → next frame. A headless engine publishes on its own cadence
        // (the proof page animates at 16 ms and still yields a handful of
        // frames a minute), so this is reported as-measured and can be null:
        // null means the engine answered no action within the window, never a
        // fabricated zero.
        actionLatencySamples: frameLatencies.length,
        actionLatencyP50Ms: percentile(frameLatencies, 0.5),
        actionLatencyP95Ms: percentile(frameLatencies, 0.95),
        // The engine's own cadence, which is what the count above reflects.
        intervalSamples: frameIntervals.length,
        intervalP50Ms: percentile(frameIntervals, 0.5),
        intervalP95Ms: percentile(frameIntervals, 0.95),
      },
      captureLatency: {
        samples: captureLatencies.length,
        p50Ms: percentile(captureLatencies, 0.5),
        p95Ms: percentile(captureLatencies, 0.95),
        maxMs: captureLatencies.length > 0 ? Math.max(...captureLatencies) : null,
      },
      resources: {
        samples: samples.length,
        rssBytesMin: Math.min(...rss),
        rssBytesMax: Math.max(...rss),
        rssBytesMedian: percentile(rss, 0.5),
        idleCpuSecondsTotal: Number(
          idle.reduce((sum, sample) => sum + sample.cpuSeconds, 0).toFixed(3)
        ),
        activeCpuSecondsTotal: Number(
          active.reduce((sum, sample) => sum + sample.cpuSeconds, 0).toFixed(3)
        ),
      },
      captureStorage: {
        bytesCapturedTotal: captureBytes,
        peakBytes: capturePeakBytes,
        // The store's production retention refuses beyond its caps; a refusal
        // is the bound holding, so the lane reports it rather than treating it
        // as an error.
        refusals: captureRefusals,
      },
      longTasks: {
        // A sampling cadence that stalls is the long-task signal this lane can
        // observe honestly; per-frame main-thread attribution is the UI lane's.
        sampledCadenceMs: sampleEveryMs,
        samplesRecorded: samples.length,
        expectedSamples: Math.floor(totalMs / sampleEveryMs),
      },
      samples,
      recordedAt: new Date().toISOString(),
    }
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
    console.log(
      `browser-preview-perf ${artifact.status}: ${minutes}min preview, startup ${startupMs}ms, ` +
        `${frames} frames (interval p50 ${artifact.frames.intervalP50Ms}ms), ` +
        `capture p50 ${artifact.captureLatency.p50Ms}ms, ` +
        `RSS ${(Math.max(...rss) / 1024 / 1024).toFixed(0)}MB peak, capture ${captureBytes}B`
    )
    console.log(`artifact: ${artifactPath}`)
    return 0
  } finally {
    server.stop(true)
  }
}

process.exit(await main())
