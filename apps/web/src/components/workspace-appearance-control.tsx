import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Palette } from 'lucide-solid'
import { createSignal, Show } from 'solid-js'
import lazyComponent from './lazy-component'

const AppearanceControl = lazyComponent(
  () => import('@adea-ai/dev-view/appearance').then((module) => module.AppearanceControl),
  { ssr: false, loading: () => <AppearanceLoading /> }
)

function AppearanceLoading() {
  return (
    <ActionButton
      variant="ghost"
      size="icon-sm"
      tooltip="Loading appearance settings"
      tooltipIcon={<Palette aria-hidden="true" />}
      aria-label="Appearance settings"
      aria-busy="true"
      disabled
    >
      <Palette aria-hidden="true" />
    </ActionButton>
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
        <ActionButton
          variant="ghost"
          size="icon-sm"
          tooltip="Open appearance settings"
          tooltipIcon={<Palette aria-hidden="true" />}
          aria-label="Appearance settings"
          onClick={() => {
            setOpen(true)
            setAccessed(true)
          }}
        >
          <Palette aria-hidden="true" />
        </ActionButton>
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
