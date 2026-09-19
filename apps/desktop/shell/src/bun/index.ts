// Adea desktop shell — Electrobun 2.x (Bun main process, bundled CEF view).
// Serves the single UI (apps/web's TanStack Start SPA output, built by
// apps/desktop/scripts/client.mjs) from disk on a loopback port, injects the
// bridge script into the document, and hosts the desktop command surface
// behind the M10 channel gate (issue #33): the legacy invoke/events paths and
// the full-duplex `dev.runtime.*` channel all authenticate through
// src/dev-runtime/channel/. The view is pinned to the loopback origin: no
// remote navigation.
import { BrowserWindow } from 'electrobun/main'
import { promises as dns } from 'node:dns'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { agentSimResponse } from '../agent-sim-assets'
import { proxyCloudRequest, resolveCloudOrigin } from '../cloud-proxy'
import { createCommandSurface } from '../commands'
import { registerBrowserDeviceRuntime } from '../dev-runtime/browser/register'
import { registerProjectSessionRuntime } from '../dev-runtime/project-session/register'
import {
  devOperationDefinitions,
  type DevOperation,
} from '../../../../../packages/types/src/dev-runtime'
import { ChannelRejection, createChannelAuthority } from '../dev-runtime/channel/authority'
import { createChannelGateway, type SocketData } from '../dev-runtime/channel/server'

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
const RUNTIME_SCOPE = {
  accountId: process.env.ADEA_ACCOUNT_ID ?? '',
  workspaceId: process.env.ADEA_WORKSPACE_ID ?? '',
  runtimeNodeId: process.env.ADEA_RUNTIME_NODE_ID ?? '',
} as const
const hasRuntimeScope = Object.values(RUNTIME_SCOPE).every((value) => value.length > 0)
// Optional Agent Sim engine pack directory (scripts/pack-agent-sim.mjs layout).
const AGENT_SIM_DIST = process.env.ADEA_AGENT_SIM_DIST

const invoke = createCommandSurface(DATA_DIR)
// The M10 channel authority binds the trusted window and gates every command;
// the gateway owns the `/__adea/*` routes and the full-duplex WebSocket.
const authority = createChannelAuthority({
  shellHost: `127.0.0.1:${PORT}`,
  shellOrigin: SHELL_ORIGIN,
  authorizeCommand: (command) => {
    if (
      !hasRuntimeScope ||
      command.scope.accountId !== RUNTIME_SCOPE.accountId ||
      command.scope.workspaceId !== RUNTIME_SCOPE.workspaceId ||
      command.scope.runtimeNodeId !== RUNTIME_SCOPE.runtimeNodeId
    ) {
      throw new ChannelRejection(
        'channel_unauthenticated',
        'authenticated account/workspace/runtime-node scope is unavailable',
        403
      )
    }
  },
})
const gateway = createChannelGateway({ authority, invoke, shellOrigin: SHELL_ORIGIN })
// Register every contract operation before optional native adapters. Missing
// sidecars, harnesses, and host utilities fail closed as typed unavailable
// instead of appearing as unknown commands or false successes.
for (const operation of Object.keys(devOperationDefinitions) as DevOperation[]) {
  if (operation === 'dev.capability.snapshot') continue
  authority.registerCommandProvider(operation, () => {
    throw {
      code: 'capability_unavailable',
      retryable: true,
      message: `no host adapter is available for ${operation}`,
      observedAt: new Date().toISOString(),
    }
  })
}
// #422: the browser/device lane providers dispatch through the same M10 gate.
// The loopback listener scan is the optional OS inspection; Adea-owned
// launch metadata stays the primary port authority.
registerBrowserDeviceRuntime({
  authority,
  gateway,
  scope: hasRuntimeScope ? RUNTIME_SCOPE : undefined,
  runLsof: async () => {
    const proc = Bun.spawn(['lsof', '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text
  },
  resolveDns: async (hostname) => {
    try {
      const [a, aaaa] = await Promise.all([
        dns.resolve4(hostname).catch(() => [] as string[]),
        dns.resolve6(hostname).catch(() => [] as string[]),
      ])
      return [
        ...a.map((address) => ({ address, family: 4 as const })),
        ...aaaa.map((address) => ({ address, family: 6 as const })),
      ]
    } catch {
      return []
    }
  },
})
if (hasRuntimeScope) {
  registerProjectSessionRuntime({ authority, dataDir: DATA_DIR, scope: RUNTIME_SCOPE })
}

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

function injectBridge(html: string): string {
  if (html.includes('/__adea/bridge.js')) return html
  // The one-time launch bootstrap rides only this injected script tag: it is
  // the trusted window's handshake capability (the bridge script itself
  // carries no secrets).
  const bootstrap = gateway.bootstrapToken()
  const scopeScript = hasRuntimeScope
    ? `<script>window.__ADEA_DEV_SCOPE__=${JSON.stringify(RUNTIME_SCOPE)}</script>`
    : ''
  return html.replace(
    '<head>',
    `<head><script>window.__ADEA_LAUNCH_BOOTSTRAP__=${JSON.stringify(bootstrap)}</script>${scopeScript}<script src="/__adea/bridge.js"></script>`
  )
}

// The post-update relaunch can race the old bundle's socket release, so the
// bind is retried for a bounded window instead of dying inside the launcher.
let server: ReturnType<typeof Bun.serve> | undefined
for (let attempt = 0; attempt < 30 && !server; attempt++) {
  if (attempt > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  try {
    server = Bun.serve<SocketData>({
      hostname: '127.0.0.1',
      port: PORT,
      async fetch(request, bunServer) {
        const url = new URL(request.url)
        try {
          // Everything under /__adea/* — bridge script, guarded invoke,
          // handshake, events, and the authenticated full-duplex channel —
          // is the M10 boundary's surface.
          if (url.pathname.startsWith('/__adea/')) {
            const response = await gateway.handle(request, (req, data) =>
              bunServer.upgrade(req, { data })
            )
            // After a successful upgrade Bun discards any response; a 101
            // Response is only the fallthrough for a failed upgrade.
            return response
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
      websocket: {
        open: (socket) => gateway.websockets.open(socket),
        message: (socket, message) => gateway.websockets.message(socket, message),
        close: (socket) => gateway.websockets.close(socket),
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
