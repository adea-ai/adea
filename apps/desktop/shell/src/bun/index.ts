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
import {
  createChannelGateway,
  type ChannelGateway,
  type SocketData,
} from '../dev-runtime/channel/server'
import { createDevRuntimeHost, type DevRuntimeHost } from '../dev-runtime'
import { createFileStreamRelay } from '../dev-runtime/stream-relay'
import { createOwnerApprovalVerifier } from '../dev-runtime/authority'
import {
  loadPackagedManifestForEntry,
  resolvePackagedComponents,
} from '../../scripts/packaged-install'
import { createProcessAdapter } from '../supervision/process-adapter'
import type { SupervisionAdapter } from '../supervision/supervisor'
import type { SidecarClient } from '../dev-runtime/terminal/sidecar/client'
import {
  adoptShellTerminalSidecar,
  reconcileSupervisionAtBoot,
  SIDECAR_COMPONENT_ID,
} from './boot-supervision'
import { devSidecarPlan, packagedSidecarPlan, type ShellSidecarPlan } from './boot-sidecar-plan'

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

// The packaged component manifest (M10 #185): when this process runs from the
// bundled .app layout, the packaging lane's strict install-location resolution
// loads the component manifest and the composition below constructs and holds
// the one supervision engine over it. A dev run (repo checkout) has no bundle,
// and a bundle whose manifest fails to load is degraded, not faked: the shell
// boots exactly as before — truthful-empty resource listings and typed
// `capability_unavailable` stops — never fabricated supervision state.
const packagedManifest = loadPackagedManifestForEntry(import.meta.dir)
if (!packagedManifest.ok && packagedManifest.appBundle) {
  console.error(
    `desktop shell: the packaged component manifest failed to load (${packagedManifest.reason}); the local stack runs without supervision`
  )
}

// The terminal lane's sidecar plan (#396) and the supervision engine's real
// process adapter: a packaged boot resolves the bundled sidecar command (the
// packaged entry on the bundled Bun runtime) from the same install-location
// resolution the manifest loader ran, so the engine's spawn and the lane's
// adoption describe one artifact. A packaged boot never falls back to a dev
// spawn: an unresolvable packaged command leaves the plan undefined and the
// terminal lane typed-unavailable. A repo dev run keeps the dev fallback
// (the source-tree entry on the repo toolchain).
let sidecarPlan: ShellSidecarPlan | undefined
let supervisionAdapter: SupervisionAdapter | undefined
if (packagedManifest.ok) {
  try {
    const packaged = resolvePackagedComponents(packagedManifest.appBundle)
    const commands = packaged.commands(DATA_DIR)
    const command = commands[SIDECAR_COMPONENT_ID]
    const sidecarIdentity = command?.env?.ADEA_SIDECAR_IDENTITY
    if (command && sidecarIdentity) {
      sidecarPlan = packagedSidecarPlan(sidecarIdentity)
      supervisionAdapter = createProcessAdapter(commands)
    } else {
      console.error(
        'desktop shell: the packaged sidecar command is missing from the bundle resolution; the terminal lane stays unavailable'
      )
    }
  } catch (error) {
    console.error(
      `desktop shell: the packaged sidecar command could not be resolved (${error instanceof Error ? error.message : String(error)}); the terminal lane stays unavailable`
    )
  }
} else if (packagedManifest.appBundle === null) {
  // A repo dev run (no bundle at all) keeps the dev fallback. A packaged
  // bundle whose manifest failed to load is degraded: no supervision and no
  // sidecar plan — the terminal lane stays typed-unavailable, never a dev
  // spawn on the repo toolchain from an installed app.
  sidecarPlan = devSidecarPlan()
}

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
  const relayHandler = streamRelayCommands[cmd]
  if (relayHandler) {
    try {
      return { ok: true, value: (await relayHandler(args)) ?? null }
    } catch {
      return { ok: false, error: 'stream relay command failed' }
    }
  }
  return baseInvoke(cmd, args)
}

const gateway = createChannelGateway({ authority, invoke, shellOrigin: SHELL_ORIGIN })

// The renderer's bulk-stream attach relay (#399 residue): provider
// byte-halves register through this view so the relay can drive them over an
// in-memory session on the page's own channel. The bridge cannot bind a
// second WebSocket — the launch bootstrap is consumed once per page, grants
// are caller-channel-bound, and every handshake mints a new channel — so the
// attach rides the real `attachStream` + provider contract through the relay,
// with frames crossing on the signed event/invoke paths.
const hostStreamProviders = new Map<
  string,
  Parameters<ChannelGateway['registerStreamHandler']>[1]
>()
const gatewayView: ChannelGateway = {
  ...gateway,
  registerStreamHandler: (protocol, provider) => {
    hostStreamProviders.set(protocol, provider)
    gateway.registerStreamHandler(protocol, provider)
  },
}
const fileStreamRelay = createFileStreamRelay({
  authority,
  providerFor: (protocol) => hostStreamProviders.get(protocol),
  publish: (event, payload) => gateway.publish(event, payload),
})

/** Relay commands present the channel identity the bridge holds (public
 *  binding values); every relay operation re-proves it against the session
 *  and the attach proof under the channel secret. */
function relayIdentity(args?: Record<string, unknown>) {
  return {
    channelId: String(args?.channelId ?? ''),
    clientCredentialId: String(args?.clientCredentialId ?? ''),
  }
}
const streamRelayCommands: Record<string, (args?: Record<string, unknown>) => unknown> = {
  desktop_file_stream_open: (args) =>
    fileStreamRelay.open({ identity: relayIdentity(args), attach: args?.attach }),
  desktop_file_stream_frame: (args) =>
    fileStreamRelay.frame({
      identity: relayIdentity(args),
      streamId: String(args?.streamId ?? ''),
      frame: args?.frame,
    }),
  desktop_file_stream_close: (args) =>
    fileStreamRelay.dispose({
      identity: relayIdentity(args),
      streamId: String(args?.streamId ?? ''),
    }),
}

// The Dev Runtime host composition: registers every production provider
// (grant authorities, project/session projection, browser/device lanes,
// worktrees, terminal when the sidecar is present) and typed-unavailable
// providers for everything else. Re-binding under a different scope
// recomposes after the composition revoked the old binding's channels.
let host: DevRuntimeHost | undefined
// The terminal lane's adopted sidecar client, when the boot adoption
// succeeded; the composition binds it through the existing `sidecar` seam.
let sidecarClient: SidecarClient | undefined
function composeHost(): DevRuntimeHost {
  return createDevRuntimeHost({
    authority,
    gateway: gatewayView,
    dataDir: DATA_DIR,
    scope: identity.currentScope(),
    identity,
    approvalVerifier,
    runtimeRoot: join(DATA_DIR, 'dev-runtime', 'runtime'),
    // #185: the packaged manifest feeds the one supervision engine; absent
    // (dev run) or failed load keeps the truthful no-supervision composition.
    ...(packagedManifest.ok ? { componentManifest: packagedManifest.manifest } : {}),
    // #185: the engine spawns packaged components through the real bundled
    // layout (dev runs have no adapter — the engine itself never starts).
    ...(supervisionAdapter ? { supervisionAdapter } : {}),
    // #396: the terminal lane runs on the adopted sidecar; without one the
    // terminal operations stay typed-unavailable.
    ...(sidecarClient ? { sidecar: sidecarClient } : {}),
    // #31 consumer zero-config (the handoff the managed-Pi lane pinned): the
    // production boot opts into the managed Pi warm — fire-and-forget, every
    // failure a typed durable driver state, skipped for injected drivers.
    managedPiAutoInstall: true,
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

// Boot adoption steps (#185/#396), serialized across recompositions. After
// the composition holds the engine, the persisted launch journal is
// reconciled: a sidecar launch persisted by a previous app run is adopted
// (ownership re-proven against the live OS) or journaled as an unadoptable
// expected exit — never left dangling. Then the terminal lane's sidecar is
// adopted through the existing seam (packaged: started through the engine
// and connected over the bundled layout; dev: the dev fallback), and a
// successful adoption recomposes so `dev.terminal.*` registers.
let bootSteps: Promise<void> = Promise.resolve()
async function adoptTerminalSidecar(): Promise<void> {
  const scope = identity.currentScope()
  if (!scope) return
  const adoption = await adoptShellTerminalSidecar({
    dataDir: DATA_DIR,
    scope,
    supervisor: host?.supervision,
    plan: sidecarPlan,
  })
  if (!adoption.ok) {
    console.error(
      `desktop shell: the terminal sidecar could not be adopted (${adoption.code}: ${adoption.message}); the terminal lane stays unavailable`
    )
    return
  }
  if (sidecarClient !== adoption.client) {
    sidecarClient?.close()
    sidecarClient = adoption.client
    host = composeHost()
  }
}
async function runBootSteps(): Promise<void> {
  if (!host) return
  const reconcile = await reconcileSupervisionAtBoot(host)
  if (reconcile.attempted) {
    if (reconcile.error) {
      console.error(`desktop shell: supervision reconcile failed: ${reconcile.error}`)
    }
    for (const entry of reconcile.adopted) {
      console.log(
        `desktop shell: adopted the persisted ${entry.componentId} launch (pid ${entry.pid}, generation ${entry.generation})`
      )
    }
    for (const entry of reconcile.unadoptable) {
      console.log(
        `desktop shell: the persisted ${entry.componentId} launch (generation ${entry.generation}) is unadoptable; journaled as an expected exit`
      )
    }
  }
  await adoptTerminalSidecar()
}
function queueBootSteps(): void {
  bootSteps = bootSteps.then(runBootSteps, runBootSteps)
}
identity.onBindingChanged(() => {
  host = composeHost()
  queueBootSteps()
})
queueBootSteps()
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
