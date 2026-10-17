import { createResource, createSignal, Show, onCleanup, onMount } from 'solid-js'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import { useWorkspaceState } from '@adea-ai/state'
import {
  canonicalBridgeOrigin,
  createOriginAllowlist,
  parseFrameMessage,
  type SimSurface,
} from '@adea-ai/spatial/sim-bridge'
import { HostedAgentSim, type HostedSimFrame } from '@adea-ai/workspace-ui/hosted-agent-sim'

/** App wiring only: Chat and Dev do not subscribe to this optional surface. */
export function HostedSimEntry(props: {
  client?: AgentHqApiClient
  scene?: 'home' | 'work'
  surface?: SimSurface
  character?: string
  onClose?: () => void
}) {
  const [fallbackClient] = createSignal(createApiClient())
  const client = () => props.client ?? fallbackClient()
  const workspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const [configuration, { refetch }] = createResource(client, async (api) => {
    try {
      return await api.simConfiguration()
    } catch {
      return { frameOrigin: null, allowLoopbackHttp: false }
    }
  })
  const origin = () =>
    canonicalBridgeOrigin(configuration()?.frameOrigin, {
      allowLoopbackHttp: configuration()?.allowLoopbackHttp === true,
    })
  let container: HTMLDivElement | undefined
  let frame: HostedSimFrame | undefined
  const online = () => {
    void refetch()
  }
  const message = (event: MessageEvent) => {
    const active = frame
    const source = container?.querySelector('iframe')?.contentWindow
    if (!active || !source) return
    const result = parseFrameMessage(event, {
      origins: createOriginAllowlist([active.origin], {
        allowLoopbackHttp: configuration()?.allowLoopbackHttp === true,
      }),
      frameWindow: source,
      bridgeId: active.bridgeId,
    })
    if (result.ok && result.message.type === 'frame.close') props.onClose?.()
  }
  onMount(() => {
    window.addEventListener('online', online)
    window.addEventListener('message', message)
    onCleanup(() => {
      window.removeEventListener('online', online)
      window.removeEventListener('message', message)
    })
  })
  return (
    <div
      ref={(element) => {
        container = element
      }}
      class="size-full"
    >
      <Show when={props.scene ?? 'home'} keyed>
        {(scene) => (
          <HostedAgentSim
            frameOrigin={origin()}
            allowLoopbackHttp={configuration()?.allowLoopbackHttp === true}
            workspaceId={workspaceId() ?? ''}
            surface={props.surface ?? 'hq'}
            platform={
              typeof window !== 'undefined' && '__adeaDesktop' in window ? 'desktop' : 'web'
            }
            character={props.character}
            requestGrant={(request, signal) => client().requestSimLaunch(request, signal)}
            frameUrl={(next) => {
              frame = next
              const url = new URL('/frame', next.origin)
              // Non-secret mount context stays in the fragment, outside request/referrer logs.
              url.hash = new URLSearchParams({
                parentOrigin: window.location.origin,
                bridgeId: next.bridgeId,
                scene,
              }).toString()
              return url.toString()
            }}
            class="size-full"
          />
        )}
      </Show>
    </div>
  )
}
