// Adea desktop shell — Electrobun 2.x (Bun main process, bundled CEF view).
// Serves the single UI (apps/web's TanStack Start SPA output, built by
// apps/desktop/scripts/client.mjs) from disk on a loopback port, injects the
// bridge script into the document, and hosts the desktop command surface
// behind the M10 channel gate (issue #33): the legacy invoke/events paths and
// the full-duplex `dev.runtime.*` channel all authenticate through
// src/dev-runtime/channel/. The Dev Runtime scope is not injected as a
// global: it is verified against the cloud from the app's own signed bind
// request and enforced at the gate before any privileged dispatch.
import { BrowserWindow } from 'electrobun/main'
import { promises as dns } from 'node:dns'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { agentSimResponse } from '../agent-sim-assets'
import { proxyCloudRequest, resolveCloudOrigin } from '../cloud-proxy'
import { createCommandSurface, type BridgeResult } from '../commands'
import {
  createCloudIdentityVerifier,
  createDesktopIdentityAuthority,
  type DesktopSessionCredential,
  type Scope,
} from '../dev-runtime/channel/identity'
import { createChannelAuthority } from '../dev-runtime/channel/authority'
import { createChannelGateway, type SocketData } from '../dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../dev-runtime'
import { createOwnerApprovalVerifier } from '../dev-runtime/authority'

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

// The durable, single-use owner-approval authority. Constructed first so the
// composition cannot exist without it: vault, root, and grant authorities
// refuse to build when the verifier is missing (fail-open remediation).
const approvalVerifier = createOwnerApprovalVerifier({ dataDir: DATA_DIR })

const baseInvoke = createCommandSurface(DATA_DIR)
// The authenticated scope authority: the verified (account, workspace,
// runtime node) binding plus bounded-TTL runtime-node eligibility.
const identity = createDesktopIdentityAuthority({
  dataDir: DATA_DIR,
  verifier: createCloudIdentityVerifier({ cloudOrigin: CLOUD_ORIGIN, shellOrigin: SHELL_ORIGIN }),
})
// The M10 channel authority binds the trusted window and gates every command.
// Scope admission runs before capability checks and provider dispatch: a
// command whose scope differs from the verified identity binding is refused
// as `channel_unauthorized` before the registry capability set is compared.
const authority = createChannelAuthority({
  shellHost: `127.0.0.1:${PORT}`,
  shellOrigin: SHELL_ORIGIN,
  authorizeCommand: async (command) => {
    identity.assertCommandScope(command.scope)
    // Eligibility is re-proven on a bounded TTL: a revoked or unpaired
    // runtime node fails every privileged operation, not just the first.
    await identity.ensureNodeEligible()
  },
})

// The signed identity bind/scope/unbind commands ride the guarded legacy
// invoke path (the trusted window's channel), so the renderer can never
// assert a scope directly: the shell verifies the presented desktop session
// against the cloud before any binding exists.
const identityCommands: Record<
  string,
  (args?: Record<string, unknown>) => unknown | Promise<unknown>
> = {
  desktop_identity_bind: (args) => {
    const session = args?.session as DesktopSessionCredential | undefined
    const claimed = args?.claimed as Scope | undefined
    if (!session || !claimed) throw new Error('identity bind requires session and claimed scope')
    return identity.bind({ session, claimed })
  },
  desktop_identity_scope: () => {
    const scope = identity.currentScope()
    if (!scope) throw new Error('no authenticated identity is bound')
    return scope
  },
  desktop_identity_unbind: () => {
    identity.unbind('owner sign-out')
    return null
  },
}
async function invoke(cmd: string, args?: Record<string, unknown>): Promise<BridgeResult> {
  const identityHandler = identityCommands[cmd]
  if (identityHandler) {
    try {
      return { ok: true, value: (await identityHandler(args)) ?? null }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'identity command failed',
      }
    }
  }
  return baseInvoke(cmd, args)
}

const gateway = createChannelGateway({ authority, invoke, shellOrigin: SHELL_ORIGIN })

// The Dev Runtime host composition: registers every production provider
// (grant authorities, project/session projection, browser/device lanes,
// worktrees, terminal when the sidecar is present) and typed-unavailable
// providers for everything else. Re-binding under a different scope
// recomposes after the composition revoked the old binding's channels.
let host: DevRuntimeHost | undefined
function composeHost(): DevRuntimeHost {
  return createDevRuntimeHost({
    authority,
    gateway,
    dataDir: DATA_DIR,
    scope: identity.currentScope(),
    identity,
    approvalVerifier,
    runtimeRoot: join(DATA_DIR, 'dev-runtime', 'runtime'),
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
    publish: (event, payload) => gateway.publish(event, payload),
  })
}
host = composeHost()
identity.onBindingChanged(() => {
  host = composeHost()
})
void host

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

/**
 * The one-time launch bootstrap rides only the app window's own document
 * load: a browser-context request carries fetch metadata (`Sec-Fetch-Dest:
 * document` with a trusted site value). A header-less local process — curl,
 * a script, any non-browser client — receives HTML without the credential,
 * so the launch bootstrap cannot be retrieved by omitting Origin/Sec-Fetch
 * headers, and using it still requires passing the trusted-origin gate at
 * the handshake.
 */
function shouldInjectBootstrap(request: Request): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site')
  const secFetchDest = request.headers.get('sec-fetch-dest')
  return (secFetchSite === 'none' || secFetchSite === 'same-origin') && secFetchDest === 'document'
}

function injectBridge(html: string, request: Request): string {
  if (html.includes('/__adea/bridge.js')) return html
  // The one-time launch bootstrap rides only this injected script tag: it is
  // the trusted window's handshake capability (the bridge script itself
  // carries no secrets).
  const bootstrap = shouldInjectBootstrap(request)
    ? `<script>window.__ADEA_LAUNCH_BOOTSTRAP__=${JSON.stringify(gateway.bootstrapToken())}</script>`
    : ''
  return html.replace('<head>', `<head>${bootstrap}<script src="/__adea/bridge.js"></script>`)
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
            body = new TextEncoder().encode(injectBridge(new TextDecoder().decode(body), request))
          }
          return new Response(body, {
            headers: {
              'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
              // The injected bootstrap is single-use and per-document load;
              // no cache may retain it.
              'cache-control': 'no-store',
            },
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
