import '../../src/start/globals.css'
import { render } from 'solid-js/web'
import { TooltipProvider } from '@adea-ai/ui/components/ui/tooltip'
import { AgentStatusBadge } from '../../../../packages/workspace-ui/src/agent-status'
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
render(
  () => (
    <TooltipProvider openDelay={200} closeDelay={300} skipDelayDuration={300}>
      <AgentStatusBadge agent={agent} />
      <button>Next action</button>
    </TooltipProvider>
  ),
  document.querySelector('#harness-root')!
)
