// The workspace-wide runtime-resources control (#424). It lives in the shared
// top bar so the action is available by default on every view; the Dev entry
// no longer carries its own trigger. The sheet — and the Dev runtime seam it
// needs — rides a lazy chunk that loads on the first open, so the top bar
// pays only this button.
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { Gauge } from 'lucide-solid'
import { createSignal, Show } from 'solid-js'
import { useWorkspaceState } from '@adea-ai/state'
import lazyComponent from './lazy-component'

const ResourcesSheet = lazyComponent(
  () => import('@adea-ai/dev-view/resources/sheet').then((module) => module.ResourcesSheet),
  { loading: () => null }
)

export function RuntimeResourcesControl(props: { runtime?: DevRuntimeService }) {
  const [open, setOpen] = createSignal(false)
  // The selected session is presentation state shared across views, so the
  // sheet scopes to the same session the Dev surfaces show.
  const runtimeSessionId = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  return (
    <>
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        tooltip={open() ? 'Close runtime resources' : 'Open runtime resources'}
        tooltipIcon={<Gauge aria-hidden="true" />}
        class="workspace-topbar__control"
        aria-label="Runtime resources"
        aria-pressed={open()}
        onClick={() => setOpen(!open())}
      >
        <Gauge aria-hidden="true" />
      </ActionButton>
      <Show when={open()}>
        <ResourcesSheet
          runtime={props.runtime}
          runtimeSessionId={runtimeSessionId() || undefined}
          onClose={() => setOpen(false)}
        />
      </Show>
    </>
  )
}
