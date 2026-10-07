import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { createSignal, onMount, Show } from 'solid-js'
import { Bell, RefreshCw, Search } from 'lucide-solid'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@adea-ai/ui/components/ui/tooltip'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { AgentStatus, AgentStatusBadge } from '../../../../packages/workspace-ui/src/agent-status'
import type { AgentSummary } from '@adea-ai/types'
import { Button } from '@adea-ai/ui/components/ui/button'

const agent: AgentSummary = {
  id: 'synthetic-agent',
  name: 'Fixture agent',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  workspaceId: 'synthetic-workspace',
  lifecycleState: 'active',
  presentationMetadata: {},
  profile: { id: 'synthetic-profile', state: 'available', version: '1' },
}
const [currentAgent, setCurrentAgent] = createSignal(agent)
const [sheetOpen, setSheetOpen] = createSignal(false)

/**
 * Mimics the shared sheet contract the workspace resources sheet uses: a
 * dialog whose first tabbable control receives focus on mount. That focus is
 * programmatic, so the tooltip must stay closed until a real hover.
 */
function MockResourcesSheet(props: { onClose(): void }) {
  const [panel, setPanel] = createSignal<HTMLDivElement>()
  onMount(() => panel()?.querySelector('button')?.focus())
  return (
    <div role="dialog" aria-label="Runtime resources mock" ref={setPanel}>
      <ActionButton
        type="button"
        variant="ghost"
        size="icon-sm"
        tooltip="Refresh runtime resources"
        aria-label="Refresh resources"
        onClick={() => {}}
      >
        <RefreshCw aria-hidden="true" />
      </ActionButton>
      <Button onClick={() => props.onClose()}>Close runtime sheet mock</Button>
    </div>
  )
}

render(
  () => (
    <TooltipProvider openDelay={200} closeDelay={300} skipDelayDuration={300}>
      <section aria-label="Status badge">
        <AgentStatusBadge agent={currentAgent()} />
      </section>
      <section aria-label="Status details">
        <AgentStatus agent={currentAgent()} compact />
      </section>
      <Button
        onClick={() =>
          setCurrentAgent({ ...agent, profile: { ...agent.profile, state: 'missing' } })
        }
      >
        Invalidate profile
      </Button>
      <Button onClick={() => setCurrentAgent({ ...agent, lifecycleState: 'archived' })}>
        Archive agent
      </Button>
      <Button onClick={() => setCurrentAgent(agent)}>Restore agent</Button>
      <Button>Next action</Button>
      <section aria-label="Icon action">
        <Tooltip>
          <TooltipTrigger aria-label="Search this conversation">
            <Search aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent icon={<Search aria-hidden="true" />}>
            Search this conversation (Mod+F)
          </TooltipContent>
        </Tooltip>
      </section>
      <section aria-label="Icon action button">
        <ActionButton
          variant="ghost"
          size="icon-sm"
          tooltip="Notifications are not available yet."
          tooltipIcon={<Bell aria-hidden="true" />}
          aria-label="Notifications"
          aria-description="Notifications are not available yet."
          disabled
        >
          <Bell aria-hidden="true" />
        </ActionButton>
      </section>
      <section aria-label="Sheet autofocus">
        <Show
          when={sheetOpen()}
          fallback={<Button onClick={() => setSheetOpen(true)}>Open runtime sheet mock</Button>}
        >
          <MockResourcesSheet onClose={() => setSheetOpen(false)} />
        </Show>
      </section>
    </TooltipProvider>
  ),
  document.querySelector('#harness-root')!
)
