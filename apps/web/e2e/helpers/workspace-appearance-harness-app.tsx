import '../../src/start/globals.css'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { ThemeProvider } from '@adea-ai/app-ui/components/theme-provider'
import { AppearanceControl } from '@adea-ai/dev-view/appearance'

function Harness() {
  const [open, setOpen] = createSignal(false)
  return (
    <ThemeProvider>
      <AppearanceControl
        open={open()}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
      />
    </ThemeProvider>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
