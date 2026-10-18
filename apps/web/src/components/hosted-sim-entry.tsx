import { createResource, createSignal, Show, onCleanup, onMount } from 'solid-js'
import { createApiClient, type AgentHqApiClient } from '@adea-ai/api-client'
import { useWorkspaceState } from '@adea-ai/state'
import {
  canonicalBridgeOrigin,
  createOriginAllowlist,
  parseFrameMessage,
  describeSimAvailability,
  type SimSurface,
} from '@adea-ai/spatial/sim-bridge'
import { Alert, AlertTitle, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import { HostedAgentSim, type HostedSimFrame } from '@adea-ai/workspace-ui/hosted-agent-sim'
import { commitSimCharacter, navigateSimDesigner } from '../lib/sim-route'

/** App wiring only: Chat and Dev do not subscribe to this optional surface. */
export function HostedSimEntry(props: {
  client?: AgentHqApiClient
  scene?: 'home' | 'work'
  surface?: SimSurface
  character?: string
  onClose?: () => void
}) {
  const [frameGeneration, setFrameGeneration] = createSignal(1)
  const [frameReloadFailed, setFrameReloadFailed] = createSignal(false)
  const [fallbackClient] = createSignal(createApiClient())
  const client = () => props.client ?? fallbackClient()
  const workspaceId = useWorkspaceState((state) => state.selectedWorkspaceId)
  const [isOnline, setIsOnline] = createSignal(
    typeof navigator === 'undefined' || navigator.onLine !== false
  )
  const [configuration, { refetch }] = createResource(
    () => isOnline() && client(),
    async (
      api
    ): Promise<{ frameOrigin: string | null; allowLoopbackHttp?: boolean; failed?: boolean }> => {
      try {
        return await api.simConfiguration()
      } catch {
        return { frameOrigin: null, allowLoopbackHttp: false, failed: true }
      }
    }
  )
  const origin = () =>
    canonicalBridgeOrigin(configuration()?.frameOrigin, {
      allowLoopbackHttp: configuration()?.allowLoopbackHttp === true,
    })
  let container: HTMLDivElement | undefined
  let frame: HostedSimFrame | undefined
  const online = () => {
    setIsOnline(true)
  }
  const offline = () => {
    setIsOnline(false)
  }
  const notice = () =>
    !isOnline()
      ? describeSimAvailability({ phase: 'offline', attempt: 0 })
      : configuration()?.failed || frameReloadFailed()
        ? describeSimAvailability({
            phase: 'unavailable',
            reason: 'service_unavailable',
            attempt: 0,
          })
        : null
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
  // Register before rendering the child: its close handler synchronously removes
  // the iframe, so the app must authenticate this event against the live window first.
  if (typeof window !== 'undefined') {
    window.addEventListener('message', message, { capture: true })
    onCleanup(() => window.removeEventListener('message', message, { capture: true }))
  }
  onMount(() => {
    // Moving a live iframe destroys its browsing context in Chromium. The
    // controller intentionally refuses ready replays, so replace the component
    // and obtain a fresh grant instead of replaying a consumed launch code.
    const frames = new Map<HTMLIFrameElement, () => void>()
    const watchFrames = () => {
      for (const [element, loaded] of frames) {
        if (container?.contains(element)) continue
        element.removeEventListener('load', loaded)
        frames.delete(element)
      }
      for (const element of container?.querySelectorAll('iframe') ?? []) {
        if (frames.has(element)) continue
        let loads = 0
        const loaded = () => {
          loads++
          if (loads < 2 || !container?.contains(element)) return
          if (frameGeneration() === 1) setFrameGeneration(2)
          else setFrameReloadFailed(true)
        }
        frames.set(element, loaded)
        element.addEventListener('load', loaded)
      }
    }
    const observer = new MutationObserver(watchFrames)
    if (container) observer.observe(container, { childList: true, subtree: true })
    watchFrames()
    onCleanup(() => {
      observer.disconnect()
      for (const [element, loaded] of frames) element.removeEventListener('load', loaded)
    })
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    onCleanup(() => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    })
  })
  return (
    <div
      ref={(element) => {
        container = element
      }}
      class="size-full"
    >
      <Show
        when={!notice()}
        fallback={
          <Alert variant="destructive">
            <AlertTitle>{notice()?.title}</AlertTitle>
            <AlertDescription>{notice()?.detail}</AlertDescription>
            <Show when={isOnline()}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFrameGeneration(1)
                  setFrameReloadFailed(false)
                  if (configuration()?.failed) void refetch()
                }}
              >
                Try again
              </Button>
            </Show>
          </Alert>
        }
      >
        <Show when={configuration.loading}>
          <p role="status">Checking Agent Sim…</p>
        </Show>
        <Show when={configuration()}>
          <Show when={frameGeneration()} keyed>
            {(_generation) => (
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
                    onNavigate={({ target }) => navigateSimDesigner(window, target)}
                    onCharacterSave={(character, request) =>
                      commitSimCharacter(window, character, request, {
                        workspaceId: workspaceId() ?? '',
                        surface: props.surface ?? 'hq',
                        bridgeId: frame?.bridgeId,
                      })
                    }
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
            )}
          </Show>
        </Show>
      </Show>
    </div>
  )
}
