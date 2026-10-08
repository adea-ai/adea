import '../../src/start/globals.css'
import { AgentHqApiClient, type ApiLeadTurnStatus } from '@adea-ai/api-client'
import { Button } from '@adea-ai/ui/components/ui/button'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { LeadTurnControls } from '../../../../packages/workspace-ui/src/lead-turn-controls'

// Scripted product reads isolate mounted Solid reactivity; no runtime/provider claim.
function Harness() {
  const [cancelCalls, setCancelCalls] = createSignal(0)
  let current: ApiLeadTurnStatus = {
    schemaVersion: 'adea-lead-turn/v1',
    intentId: '259edabb-3c45-41df-a9a9-e9a14c1b9571',
    messageId: '1b2a893b-36c9-4e71-8ab0-b9a8d3c9f377',
    state: 'running',
    availability: 'available',
    dispatchId: 'dispatch_11111111111111111111111111111111',
  }
  let resolveLatest: ((value: { leadTurn: ApiLeadTurnStatus }) => void) | undefined
  let resolveCancellation: ((value: { leadTurn: ApiLeadTurnStatus }) => void) | undefined
  const client = new AgentHqApiClient()
  client.getChannelLeadTurn = () =>
    new Promise((resolve) => {
      resolveLatest = resolve
    })
  client.getLeadTurnStatus = async () => ({ leadTurn: current })
  client.getLeadTurnProgress = async () => ({ leadTurn: current, events: [], nextSequence: 0 })
  client.cancelLeadTurn = async () => {
    setCancelCalls((count) => count + 1)
    return new Promise((resolve) => {
      resolveCancellation = resolve
    })
  }
  return (
    <>
      <Button onClick={() => resolveLatest?.({ leadTurn: current })}>
        Resolve running observation
      </Button>
      <Button
        onClick={() => {
          current = { ...current, state: 'cancelling' }
          resolveCancellation?.({ leadTurn: current })
        }}
      >
        Acknowledge cancellation request
      </Button>
      <Button
        onClick={() => {
          current = { ...current, state: 'completed' }
        }}
      >
        Observe completion next
      </Button>
      <output aria-label="Cancellation requests">{cancelCalls()}</output>
      <LeadTurnControls
        client={client}
        workspaceId="fixture-workspace"
        channelId="fixture-topic"
        audienceEpoch={0}
        onTimelineChange={() => {}}
      />
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
