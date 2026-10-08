import './lead-payer-journey-harness.css'
import { AgentHqApiClient, type ApiLeadTurnStatus } from '@adea-ai/api-client'
import type { ApiModelFundingView } from '@adea-ai/api-client/model-connections'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { LeadTurnControls } from '../../../../packages/workspace-ui/src/lead-turn-controls'

// Scripted API responses test real mounted UI state; this is not a connected runtime proof.
function Harness() {
  const [starts, setStarts] = createSignal(0)
  const [prepares, setPrepares] = createSignal(0)
  const [cancels, setCancels] = createSignal(0)
  const [epoch, setEpoch] = createSignal(0)
  const [timeline, setTimeline] = createSignal(0)
  const [settledFunding, setSettledFunding] = createSignal(0)
  let turn: ApiLeadTurnStatus = {
    schemaVersion: 'adea-lead-turn/v1',
    intentId: '259edabb-3c45-41df-a9a9-e9a14c1b9571',
    messageId: '1b2a893b-36c9-4e71-8ab0-b9a8d3c9f377',
    state: 'blocked',
    availability: 'unavailable',
  }
  const funding: Extract<ApiModelFundingView, { state: 'ready' }> = {
    schemaVersion: 'model-funding-display/v1',
    workspaceId: 'fixture-workspace',
    executionId: `exe_${'0'.repeat(26)}`,
    attemptId: `att_${'0'.repeat(26)}`,
    selectionRef: `msel_${'a'.repeat(32)}`,
    selectionRevision: 1,
    state: 'ready',
    provider: 'scripted-provider',
    providerModel: 'chosen-model',
    accountRef: 'provider-account:separate-from-payer',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    fundingOwner: {
      ownerRef: 'payer:recorded-owner',
      kind: 'workspace_account',
      displayName: 'Recorded workspace payer',
      revision: 1,
    },
    authorityRevision: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  let changedPayer = false
  let holdFunding = false
  const pendingFunding: (() => void)[] = []
  const client = new AgentHqApiClient()
  client.getChannelLeadTurn = async () => ({ leadTurn: turn })
  client.getLeadTurnStatus = async () => ({ leadTurn: turn })
  client.getLeadTurnProgress = async () => ({ leadTurn: turn, events: [], nextSequence: 0 })
  client.prepareLeadTurn = async () => {
    setPrepares((value) => value + 1)
    turn = {
      ...turn,
      state: 'prepared',
      availability: 'available',
      executionId: funding.executionId,
      attemptId: funding.attemptId,
      selectionRef: funding.selectionRef,
      selectionRevision: funding.selectionRevision,
      preparationRef: `prep_${'b'.repeat(32)}`,
      preparationExpiresAt: funding.expiresAt,
    }
    return { leadTurn: turn }
  }
  client.getModelSelectionFunding = async () => {
    if (holdFunding)
      await new Promise<void>((resolve) => {
        pendingFunding.push(resolve)
      })
    setSettledFunding((value) => value + 1)
    return {
      funding: changedPayer
        ? { ...funding, fundingOwner: { ...funding.fundingOwner, revision: 2 } }
        : funding,
    }
  }
  client.dispatchLeadTurn = async () => {
    setStarts((value) => value + 1)
    turn = {
      ...turn,
      state: 'running',
      dispatchId: `dispatch_${'c'.repeat(32)}`,
      runtimeSessionId: `ses_${'0'.repeat(26)}`,
    }
    return { leadTurn: turn }
  }
  client.cancelLeadTurn = async () => {
    setCancels((value) => value + 1)
    turn = { ...turn, state: 'cancelling' }
    return { leadTurn: turn }
  }
  return (
    <>
      <Button
        onClick={() => {
          changedPayer = true
        }}
      >
        Change recorded payer revision
      </Button>
      <Button
        onClick={() => {
          holdFunding = true
        }}
      >
        Hold funding response
      </Button>
      <Button
        onClick={() => {
          setEpoch((value) => value + 1)
        }}
      >
        Invalidate audience
      </Button>
      <Button
        onClick={() => {
          holdFunding = false
          for (const resolve of pendingFunding.splice(0)) resolve()
        }}
      >
        Release funding response
      </Button>
      <output aria-label="Prepare requests">{prepares()}</output>
      <output aria-label="Start requests">{starts()}</output>
      <output aria-label="Cancel requests">{cancels()}</output>
      <output aria-label="Timeline changes">{timeline()}</output>
      <output aria-label="Settled funding responses">{settledFunding()}</output>
      <Textarea aria-label="Independent draft" value="Unsent independent draft" />
      <LeadTurnControls
        client={client}
        workspaceId="fixture-workspace"
        channelId="fixture-topic"
        audienceEpoch={epoch()}
        onTimelineChange={() => setTimeline((value) => value + 1)}
      />
    </>
  )
}
render(() => <Harness />, document.querySelector('#harness-root')!)
