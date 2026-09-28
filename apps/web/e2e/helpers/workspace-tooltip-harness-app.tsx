import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { TooltipProvider } from '@adea-ai/ui/components/ui/tooltip'
import { AgentStatus, AgentStatusBadge } from '../../../../packages/workspace-ui/src/agent-status'
import type { AgentSummary } from '@adea-ai/types'

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

render(
  () => (
    <TooltipProvider openDelay={200} closeDelay={300} skipDelayDuration={300}>
      <section aria-label="Status badge">
        <AgentStatusBadge agent={currentAgent()} />
      </section>
      <section aria-label="Status details">
        <AgentStatus agent={currentAgent()} compact />
      </section>
      <button
        onClick={() =>
          setCurrentAgent({ ...agent, profile: { ...agent.profile, state: 'missing' } })
        }
      >
        Invalidate profile
      </button>
      <button onClick={() => setCurrentAgent({ ...agent, lifecycleState: 'archived' })}>
        Archive agent
      </button>
      <button onClick={() => setCurrentAgent(agent)}>Restore agent</button>
      <button>Next action</button>
    </TooltipProvider>
  ),
  document.querySelector('#harness-root')!
)
