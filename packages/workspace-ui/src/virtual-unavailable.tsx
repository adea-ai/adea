import { Show } from 'solid-js'
import { Button } from '@adea-ai/app-ui/components/ui/button'

export function VirtualUnavailable(props: { sceneLabel?: string; onOpenChat?: () => void }) {
  return (
    <main class="workspace-shell">
      <div class="workspace-scene-viewport">
        <div
          class="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center"
          role="status"
          aria-label="Virtual view unavailable"
        >
          <h1 class="text-xl font-semibold">Virtual view lives in Agent Sim</h1>
          <p class="max-w-md text-sm text-muted-foreground">
            {props.sceneLabel ? `The ${props.sceneLabel} scene is` : 'The spatial sim is'} part of
            the private Agent Sim engine, which is not included in this build. Chat, tasks, and the
            rest of the workspace work as usual.
          </p>
          <Show when={props.onOpenChat}>
            {(onOpenChat) => (
              <Button type="button" onClick={() => onOpenChat()()}>
                Back to chat
              </Button>
            )}
          </Show>
        </div>
      </div>
    </main>
  )
}
