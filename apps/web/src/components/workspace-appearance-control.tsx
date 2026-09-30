import { Button } from '@adea-ai/ui/components/ui/button'
import { Palette } from 'lucide-solid'
import { createSignal, Show } from 'solid-js'
import lazyComponent from './lazy-component'

const AppearanceControl = lazyComponent(
  () => import('@adea-ai/dev-view/appearance').then((module) => module.AppearanceControl),
  { ssr: false, loading: () => <AppearanceLoading /> }
)

function AppearanceLoading() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Appearance settings"
      aria-busy="true"
      disabled
    >
      <Palette aria-hidden="true" />
    </Button>
  )
}

/** Keep the editor and theme catalogue lazy until the first intentional open. */
export function WorkspaceAppearanceControl() {
  const [accessed, setAccessed] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  return (
    <Show
      when={accessed()}
      fallback={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Appearance settings"
          onClick={() => {
            setOpen(true)
            setAccessed(true)
          }}
        >
          <Palette aria-hidden="true" />
        </Button>
      }
    >
      <AppearanceControl
        open={open()}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
      />
    </Show>
  )
}
