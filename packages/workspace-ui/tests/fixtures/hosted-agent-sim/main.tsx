import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

import {
  frameEnvelope,
  type SimFrameMessage,
  type SimLaunchRequest,
  type SimSurface,
} from '@adea-ai/spatial/sim-bridge'

import { HostedAgentSim } from '../../../src/hosted-agent-sim'

// The page and the stand-in frame are served by one local server, so the frame origin is this
// page's origin. The host component sees a real iframe, real `message` events and real
// `online`/`offline` events; only the launch backend and the sim itself are stand-ins.
const FRAME_ORIGIN = window.location.origin
const params = new URL(window.location.href).searchParams

let online = params.get('online') !== '0'
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })

const [frameOrigin, setFrameOrigin] = createSignal<string | null>(
  params.get('origin') === 'none' ? null : FRAME_ORIGIN
)
const [workspaceId, setWorkspaceId] = createSignal('ws_a')
const [surface, setSurface] = createSignal<SimSurface>('hq')
// Read inside the stable `frameUrl` callback below, to prove it cannot navigate a running frame.
const [view, setView] = createSignal('a')

const grants: SimLaunchRequest[] = []

type Harness = {
  grants: SimLaunchRequest[]
  setOnline(value: boolean): void
  setFrameOrigin(value: string | null): void
  setWorkspaceId(value: string): void
  setSurface(value: SimSurface): void
  setView(value: string): void
  frameOrigin: string
  /** Delivers a message as if the current iframe had posted it, under `bridgeId`. */
  deliver(message: SimFrameMessage, bridgeId: string, version?: number): void
  /** What the current iframe's stand-in page has received from the host. */
  received(): unknown[]
}

const harness: Harness = {
  grants,
  frameOrigin: FRAME_ORIGIN,
  setOnline(value) {
    online = value
    window.dispatchEvent(new Event(value ? 'online' : 'offline'))
  },
  setFrameOrigin: setFrameOrigin,
  setWorkspaceId: setWorkspaceId,
  setSurface: setSurface,
  setView: setView,
  deliver(message, bridgeId, version = 1) {
    const iframe = document.querySelector('iframe')
    const envelope = { ...frameEnvelope(bridgeId, message), version }
    window.dispatchEvent(
      new MessageEvent('message', {
        data: envelope,
        origin: FRAME_ORIGIN,
        source: iframe?.contentWindow ?? null,
      })
    )
  },
  received() {
    const iframe = document.querySelector('iframe')
    const list = (iframe?.contentWindow as (Window & { receivedFromHost?: unknown[] }) | null)
      ?.receivedFromHost
    return list ? [...list] : []
  },
}
;(window as unknown as { agentSimHarness: Harness }).agentSimHarness = harness

render(
  () => (
    <HostedAgentSim
      frameOrigin={frameOrigin()}
      allowLoopbackHttp
      workspaceId={workspaceId()}
      surface={surface()}
      platform="web"
      requestGrant={async (request) => {
        grants.push(request)
        return {
          status: 'granted',
          code: `${String(grants.length).padStart(2, '0')}${'c'.repeat(41)}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          surface: request.surface,
          frameOrigin: FRAME_ORIGIN,
        }
      }}
      frameUrl={(frame) =>
        `${frame.origin}/frame.html?bridge=${encodeURIComponent(frame.bridgeId)}&view=${view()}`
      }
    />
  ),
  document.getElementById('app')!
)
