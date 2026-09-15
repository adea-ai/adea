// Adea desktop shell — Electrobun 2.x (Bun main process, bundled CEF view).
// Serves the single UI (apps/web's TanStack Start SPA output, built by
// apps/desktop/scripts/client.mjs) from disk on a loopback port, injects the
// bridge script into the document, and hosts the desktop command surface.
// The view is pinned to the loopback origin: no remote navigation.
import { BrowserWindow } from 'electrobun/main'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { agentSimResponse } from '../agent-sim-assets'
import { proxyCloudRequest, resolveCloudOrigin } from '../cloud-proxy'
import { createCommandSurface } from '../commands'

// The client is copied into the bundle (`electrobun.config.ts` build.copy), so
// the packaged app serves `Resources/app/client`. Running from the repo
// (`bun run shell:dev`) falls back to the web app's build output.
const CLIENT_ROOT =
  process.env.ADEA_CLIENT_ROOT ??
  (existsSync(join(import.meta.dir, '../client'))
    ? join(import.meta.dir, '../client')
    : join(import.meta.dir, '../../../../web/dist-desktop/client'))
const DATA_DIR =
  process.env.ADEA_DATA_DIR ?? join(process.env.HOME ?? '.', 'Library/Application Support/Adea')
const PORT = Number(process.env.ADEA_SHELL_PORT ?? 4789)
// The canonical cloud origin the loopback `/api` proxy forwards to; a local
// stack re-points it with ADEA_CLOUD_ORIGIN (see cloud-proxy.ts).
const CLOUD_ORIGIN = resolveCloudOrigin()
const SHELL_ORIGIN = `http://127.0.0.1:${PORT}`
// Optional Agent Sim engine pack directory (scripts/pack-agent-sim.mjs layout).
const AGENT_SIM_DIST = process.env.ADEA_AGENT_SIM_DIST

const invoke = createCommandSurface(DATA_DIR)

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

const BRIDGE_JS = `window.__adeaDesktop = {
  invoke(cmd, args) {
    return fetch("/__adea/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, args }),
    }).then(function (r) { return r.json() }).then(function (result) {
      if (!result.ok) throw new Error(result.error || "desktop command failed")
      return result.value
    })
  },
  listen(event, handler) {
    var source = new EventSource("/__adea/events?event=" + encodeURIComponent(event))
    source.onmessage = function (message) { handler({ payload: JSON.parse(message.data) }) }
    return Promise.resolve(function () { source.close() })
  },
}
`

function injectBridge(html: string): string {
  if (html.includes('/__adea/bridge.js')) return html
  return html.replace('<head>', '<head><script src="/__adea/bridge.js"></script>')
}

// The post-update relaunch can race the old bundle's socket release, so the
// bind is retried for a bounded window instead of dying inside the launcher.
let server: ReturnType<typeof Bun.serve> | undefined
for (let attempt = 0; attempt < 30 && !server; attempt++) {
  if (attempt > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: PORT,
      async fetch(request) {
        const url = new URL(request.url)
        try {
          if (url.pathname === '/__adea/bridge.js') {
            return new Response(BRIDGE_JS, { headers: { 'content-type': 'text/javascript' } })
          }
          if (url.pathname === '/__adea/invoke' && request.method === 'POST') {
            const payload = (await request.json()) as {
              cmd?: string
              args?: Record<string, unknown>
            }
            const result = await invoke(String(payload.cmd ?? ''), payload.args)
            return Response.json(result)
          }
          if (url.pathname === '/__adea/events') {
            // Long-lived SSE channel for shell events (auth callback readiness).
            let heartbeat: ReturnType<typeof setInterval> | undefined
            const stream = new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder()
                controller.enqueue(encoder.encode(': connected\n\n'))
                heartbeat = setInterval(() => {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ at: Date.now() })}\n\n`)
                  )
                }, 30_000)
              },
              cancel() {
                // Client disconnected: stop the heartbeat.
                if (heartbeat) clearInterval(heartbeat)
              },
            })
            return new Response(stream, {
              headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
            })
          }
          // The client's cloud traffic rides the same-origin proxy; the cloud's
          // desktop lane sees the trusted shell origin on every forwarded call.
          if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
            return proxyCloudRequest(request, CLOUD_ORIGIN, SHELL_ORIGIN)
          }
          if (AGENT_SIM_DIST && url.pathname.startsWith('/assets/agent-sim/')) {
            return agentSimResponse(url.pathname, AGENT_SIM_DIST)
          }
          const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
          let filePath = join(CLIENT_ROOT, rel)
          if (!filePath.startsWith(CLIENT_ROOT)) return new Response(null, { status: 403 })
          if (existsSync(filePath) && !extname(filePath)) filePath = join(filePath, 'index.html')
          if (!existsSync(filePath)) {
            // Static asset paths never fall back to the SPA shell; a missing
            // asset (e.g. an unpacked Agent Sim) is a plain 404 for the client.
            if (rel === '/assets' || rel.startsWith('/assets/')) {
              return new Response(null, { status: 404 })
            }
            filePath = join(CLIENT_ROOT, 'index.html')
          }
          let body = new Uint8Array(await Bun.file(filePath).arrayBuffer())
          if (filePath.endsWith('.html')) {
            body = new TextEncoder().encode(injectBridge(new TextDecoder().decode(body)))
          }
          return new Response(body, {
            headers: { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' },
          })
        } catch {
          return new Response(null, { status: 500 })
        }
      },
    })
  } catch {
    // The port was still held; the loop retries.
  }
}
if (!server) {
  console.error(`desktop shell: could not bind http://127.0.0.1:${PORT}`)
  process.exit(1)
}

// Electrobun registers the window as a constructor side effect; no handle to keep.
// oxlint-disable-next-line no-new
new BrowserWindow({
  title: 'Adea',
  url: `http://127.0.0.1:${PORT}/`,
  frame: { width: 1280, height: 840, x: 120, y: 90 },
})
