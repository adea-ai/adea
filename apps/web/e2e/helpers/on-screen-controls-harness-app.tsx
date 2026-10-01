import '../../src/start/globals.css'
import { OnScreenControls } from '@adea-ai/app-ui/components/on-screen-controls'
import { TooltipProvider } from '@adea-ai/ui/components/ui/tooltip'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'

const [mounted, setMounted] = createSignal(true)
const [keyEvents, setKeyEvents] = createSignal<string[]>([])
const recordKeyEvent = (event: KeyboardEvent) => {
  if (event.code === 'KeyW') {
    setKeyEvents((current) => [...current, `${event.type}:${event.code}`])
  }
}

window.addEventListener('keydown', recordKeyEvent)
window.addEventListener('keyup', recordKeyEvent)
window.addEventListener('unmount-on-screen-controls', () => setMounted(false), { once: true })

render(
  () => (
    <TooltipProvider>
      <output aria-label="Synthetic movement key events" data-testid="key-events">
        {keyEvents().join('|')}
      </output>
      <Show when={mounted()}>
        <OnScreenControls showJumpControl={false} />
      </Show>
    </TooltipProvider>
  ),
  document.querySelector('#harness-root')!
)
