import './lead-payer-journey-harness.css'
import { AgentHqApiClient } from '@adea-ai/api-client'
import { AgentHqQueryProvider } from '@adea-ai/data'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { Button } from '@adea-ai/ui/components/ui/button'
import { LeadTurnModelChoices } from '../../../../packages/workspace-ui/src/lead-turn-model-choices'
import {
  createLeadModelRequestResolver,
  type LeadRequestedChoices,
} from '../../../../packages/workspace-ui/src/lead-model-request'
import { leadRequestedChoicesKey } from '../../../../packages/workspace-ui/src/request-id'
import { MessageComposer } from '../../../../packages/workspace-ui/src/message-composer'
import { LeadTurnControls } from '../../../../packages/workspace-ui/src/lead-turn-controls'
import type { ApiLeadTurnStatus } from '@adea-ai/api-client'
import type { ApiModelFundingView } from '@adea-ai/api-client/model-connections'

// Mounted behavior uses scripted metadata/message HTTP; CP and funding are not qualified here.
function Harness() {
  const [choices, setChoices] = createSignal<LeadRequestedChoices>({})
  const [draft, setDraft] = createSignal('Unsent lead question')
  const [saved, setSaved] = createSignal('')
  const [posts, setPosts] = createSignal(0)
  const [resolves, setResolves] = createSignal(0)
  const [starts, setStarts] = createSignal(0)
  const [startedSelectionRef, setStartedSelectionRef] = createSignal('')
  const [savedTurn, setSavedTurn] = createSignal(false)
  let admittedLeadSelectionRef: string | undefined
  const [turn, setTurn] = createSignal<ApiLeadTurnStatus>({
    schemaVersion: 'adea-lead-turn/v1',
    intentId: 'intent-fixture',
    messageId: 'message-fixture',
    state: 'blocked',
    availability: 'unavailable',
  })
  const [epoch, setEpoch] = createSignal(0)
  let ready = true
  let dropAcknowledgement = true
  const target = {
    location: 'remote_host',
    harness: 'pi_durable',
    harnessVersion: '1.1.0',
    providerBinding: 'pi_durable_models',
  }
  const client = new AgentHqApiClient({
    baseUrl: '/api',
    fetchImpl: async (input, init) => {
      const payload = JSON.parse(String(init?.body))
      if (String(input).endsWith('/model-connections')) {
        if (payload.action === 'list')
          return Response.json({
            availability: 'available',
            target,
            canManage: true,
            connections: ['a', 'b'].map((key) => ({
              connectionRef: `mconn_${key.repeat(32)}`,
              revision: 1,
              provider: 'scripted',
              accountRef: `account-${key}`,
              authKind: 'api_key',
              fundingSource: 'byo_api',
              status: 'active',
              models: [
                {
                  providerModel: `model-${key}`,
                  readiness: {
                    ready,
                    reasonCode: ready ? 'READY' : 'CONNECTION_REVOKED',
                    remedy: null,
                  },
                },
              ],
            })),
          })
        if (payload.action === 'selection.resolve') {
          setResolves((value) => value + 1)
          return Response.json({
            selection: {
              ...payload.input.override,
              target,
              provider: 'scripted',
              authKind: 'api_key',
              fundingSource: 'byo_api',
              selectionRef: `msel_${(payload.input.role === 'lead' ? 'a' : 'b').repeat(32)}`,
              selectionRevision: 1,
            },
          })
        }
      }
      setPosts((value) => value + 1)
      setSaved(JSON.stringify(payload.requestedModelSelections ?? null))
      admittedLeadSelectionRef = payload.requestedModelSelections?.lead?.selectionRef
      setSavedTurn(true)
      if (dropAcknowledgement) {
        dropAcknowledgement = false
        throw new Error('Scripted lost acknowledgement')
      }
      return Response.json({
        message: { id: 'saved-message' },
        leadTurn: { intentId: 'saved-intent' },
      })
    },
  })
  const funding: Extract<ApiModelFundingView, { state: 'ready' }> = {
    schemaVersion: 'model-funding-display/v1',
    workspaceId: 'fixture',
    executionId: `exe_${'a'.repeat(26)}`,
    attemptId: `att_${'b'.repeat(26)}`,
    selectionRef: `msel_${'a'.repeat(32)}`,
    selectionRevision: 1,
    state: 'ready',
    provider: 'scripted',
    providerModel: 'model-a',
    accountRef: 'account-a',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    fundingOwner: {
      ownerRef: 'payer:workspace',
      kind: 'workspace_account',
      displayName: 'Recorded workspace payer',
      revision: 1,
    },
    authorityRevision: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  client.getChannelLeadTurn = async () => ({ leadTurn: turn() })
  client.getLeadTurnStatus = async () => ({ leadTurn: turn() })
  client.getLeadTurnProgress = async () => ({ leadTurn: turn(), events: [], nextSequence: 0 })
  client.prepareLeadTurn = async () => {
    if (!admittedLeadSelectionRef)
      return { leadTurn: { ...turn(), state: 'blocked', reasonCode: 'SELECTION_CHANGED' } }
    const next = {
      ...turn(),
      state: 'prepared' as const,
      availability: 'available' as const,
      executionId: funding.executionId,
      attemptId: funding.attemptId,
      selectionRef: admittedLeadSelectionRef,
      selectionRevision: 1,
      preparationRef: `prep_${'c'.repeat(32)}`,
      preparationExpiresAt: funding.expiresAt,
    }
    setTurn(next)
    return { leadTurn: next }
  }
  client.getModelSelectionFunding = async (_workspaceId, binding) => ({
    funding:
      binding.selectionRef === admittedLeadSelectionRef
        ? { ...funding, selectionRef: binding.selectionRef }
        : {
            schemaVersion: funding.schemaVersion,
            workspaceId: funding.workspaceId,
            executionId: binding.executionId,
            attemptId: binding.attemptId,
            selectionRef: binding.selectionRef,
            selectionRevision: binding.selectionRevision,
            state: 'blocked' as const,
            reasonCode: 'SELECTION_CHANGED' as const,
          },
  })
  client.dispatchLeadTurn = async (_workspaceId, _intentId) => {
    if (turn().selectionRef !== admittedLeadSelectionRef)
      throw new Error('Dispatched selection differs from the admitted lead choice')
    setStartedSelectionRef(turn().selectionRef!)
    setStarts((v) => v + 1)
    const next = {
      ...turn(),
      state: 'running' as const,
      dispatchId: `dispatch_${'d'.repeat(32)}`,
      runtimeSessionId: `ses_${'e'.repeat(26)}`,
    }
    setTurn(next)
    return { leadTurn: next }
  }
  client.cancelLeadTurn = async () => ({ leadTurn: turn() })
  const requests = createLeadModelRequestResolver(client)
  return (
    <>
      <Button
        onClick={() => {
          ready = false
        }}
      >
        Revoke selected models
      </Button>
      <Button
        onClick={() => {
          setEpoch((value) => value + 1)
          setChoices({})
          requests.reset()
        }}
      >
        Invalidate audience
      </Button>
      <LeadTurnModelChoices
        client={client}
        workspaceId="fixture"
        choices={choices()}
        onChange={setChoices}
      />
      <MessageComposer
        agents={[]}
        artifacts={[]}
        channelId="lead-topic"
        draft={draft()}
        onDraftChange={setDraft}
        submissionContext={leadRequestedChoicesKey(choices())}
        onSubmit={async (submission) => {
          const version = epoch()
          const requestedModelSelections = await requests.resolve(
            'fixture',
            submission.idempotencyKey,
            choices(),
            () => epoch() === version
          )
          await client.createMessage('fixture', 'lead-topic', {
            ...submission,
            leadTurn: true,
            ...(requestedModelSelections ? { requestedModelSelections } : {}),
          })
          return { clearDraft: false }
        }}
      />
      <Show when={savedTurn()}>
        <LeadTurnControls
          client={client}
          workspaceId="fixture"
          channelId="lead-topic"
          audienceEpoch={epoch()}
          onTimelineChange={() => {}}
        />
      </Show>
      <p aria-label="Lead starts">{starts()}</p>
      <p aria-label="Started selection ref">{startedSelectionRef()}</p>
      <p aria-label="Saved choices">{saved()}</p>
      <p aria-label="Message posts">{posts()}</p>
      <p aria-label="Selection resolutions">{resolves()}</p>
    </>
  )
}
render(
  () => (
    <AgentHqQueryProvider>
      <Harness />
    </AgentHqQueryProvider>
  ),
  document.getElementById('harness-root')!
)
