import { createEffect, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js'

import { Alert, AlertDescription, AlertTitle } from '@adea-ai/ui/components/ui/alert'
import { Button } from '@adea-ai/ui/components/ui/button'
import type { SimLaunchRequest, SimPlatform, SimSurface } from '@adea-ai/spatial/sim-bridge'
import {
  createHostedSimController,
  type HostedSimController,
  type HostedSimFrame,
  type HostedSimSnapshot,
} from './hosted-agent-sim-controller'

export type { HostedSimFrame, HostedSimSnapshot } from './hosted-agent-sim-controller'
export { createHostedSimController } from './hosted-agent-sim-controller'

/**
 * A hosted Agent Sim surface in an iframe. It renders nothing of the sim itself: the frame's
 * origin, how Adea asks for a launch, and the frame's address all come from the caller, so a
 * deployment without them shows the truthful "not set up" notice and makes no request.
 *
 * Chat and Dev never read this component's state, so a failed or offline sim cannot affect them.
 */
export function HostedAgentSim(props: {
  /** The sim origin to embed. Absent or invalid shows "not set up" and requests nothing. */
  frameOrigin: string | null | undefined
  allowLoopbackHttp?: boolean
  workspaceId: string
  surface: SimSurface
  platform: SimPlatform
  character?: string
  requestGrant(request: SimLaunchRequest, signal: AbortSignal): Promise<unknown>
  /**
   * The frame's address. The caller decides how the sim learns its bridge id and the embedding
   * origin (for example through the URL fragment); nothing is assumed here.
   */
  frameUrl(frame: HostedSimFrame): string
  class?: string
}) {
  const [snapshot, setSnapshot] = createSignal<HostedSimSnapshot | null>(null)
  let frameElement: HTMLIFrameElement | undefined
  let controller: HostedSimController | undefined
  let frameUrl: ((frame: HostedSimFrame) => string) | undefined

  // One launch per configuration. Everything the launch is about (origin, workspace, surface,
  // platform, character) is read here, and a change disposes the running launch and starts a new
  // one, so the grant, the frame's address and the controller always belong to the same attempt.
  // `requestGrant` and `frameUrl` are bound when the launch is created and are not tracked: change
  // the configuration to launch again. A configuration that arrives later starts the launch then.
  createEffect(() => {
    const config = {
      frameOrigin: props.frameOrigin,
      allowLoopbackHttp: props.allowLoopbackHttp,
      workspaceId: props.workspaceId,
      surface: props.surface,
      platform: props.platform,
      character: props.character,
    }
    untrack(() => {
      const requestGrant = props.requestGrant
      const instance = createHostedSimController({
        ...config,
        requestGrant: (request, signal) => requestGrant(request, signal),
        isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
        frameWindow: () => frameElement?.contentWindow ?? null,
        onChange: (next) => {
          if (controller === instance) setSnapshot(next)
        },
      })
      controller = instance
      frameUrl = props.frameUrl
      instance.start()
    })
    onCleanup(() => {
      controller?.dispose()
      controller = undefined
      frameUrl = undefined
      setSnapshot(null)
    })
  })

  const onMessage = (event: MessageEvent) =>
    controller?.handleMessage({ origin: event.origin, source: event.source, data: event.data })
  const onOffline = () => controller?.setOffline()
  const onOnline = () => controller?.setOnline()

  onMount(() => {
    window.addEventListener('message', onMessage)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    onCleanup(() => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    })
  })

  return (
    <div class={props.class} data-agent-sim-hosted>
      {/* Keyed: every attempt's frame is a new element, so a navigated frame never inherits the
          previous attempt's window or message history. */}
      <Show when={snapshot()?.frame} keyed>
        {(frame) => (
          <iframe
            ref={(element) => (frameElement = element)}
            src={frameUrl?.(frame)}
            title="Agent Sim"
            // The frame is a different origin; scripts and its own origin are all it gets.
            sandbox="allow-scripts allow-same-origin"
            referrerpolicy="no-referrer"
            class="size-full border-0"
            data-agent-sim-active={snapshot()?.state.phase === 'running' ? 'true' : undefined}
          />
        )}
      </Show>
      <Show when={snapshot()?.starting}>
        <p role="status" class="text-muted-foreground text-sm">
          Starting Agent Sim…
        </p>
      </Show>
      {/* While starting, the status line above is the whole story; the notice is for end states. */}
      <Show when={snapshot()?.starting ? null : snapshot()?.notice}>
        {(notice) => (
          <Alert variant={notice().tone === 'error' ? 'destructive' : 'default'}>
            <AlertTitle>{notice().title}</AlertTitle>
            <AlertDescription>{notice().detail}</AlertDescription>
            <Show when={notice().retryable}>
              <Button size="sm" variant="outline" onClick={() => controller?.start()}>
                Try again
              </Button>
            </Show>
          </Alert>
        )}
      </Show>
    </div>
  )
}
