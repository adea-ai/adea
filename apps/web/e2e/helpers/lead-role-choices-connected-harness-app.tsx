import './lead-payer-journey-harness.css'
import { AgentHqApiClient } from '@adea-ai/api-client'
import { AgentHqQueryProvider } from '@adea-ai/data'
import { createSignal, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { LeadTurnModelChoices } from '../../../../packages/workspace-ui/src/lead-turn-model-choices'
import {
  createLeadModelRequestResolver,
  type LeadRequestedChoices,
} from '../../../../packages/workspace-ui/src/lead-model-request'
import { leadRequestedChoicesKey } from '../../../../packages/workspace-ui/src/request-id'
import { MessageComposer } from '../../../../packages/workspace-ui/src/message-composer'
import { LeadTurnControls } from '../../../../packages/workspace-ui/src/lead-turn-controls'

function Harness() {
  const query = new URLSearchParams(location.search)
  const workspaceId = query.get('workspace') ?? ''
  const channelId = query.get('channel') ?? ''
  const client = new AgentHqApiClient({ baseUrl: '/api' })
  const [choices, setChoices] = createSignal<LeadRequestedChoices>({})
  const [draft, setDraft] = createSignal('Connected role selection question')
  const [requested, setRequested] = createSignal('')
  const [intentId, setIntentId] = createSignal('')
  const [timeline, setTimeline] = createSignal<
    readonly Readonly<{ bodyText?: string; id: string }>[]
  >([])
  const resolver = createLeadModelRequestResolver(client)

  async function refreshTimeline() {
    const page = await client.listMessages(workspaceId, channelId, { limit: 50 })
    setTimeline(page.messages.map(({ bodyText, id }) => ({ bodyText, id })))
  }

  return (
    <>
      <LeadTurnModelChoices
        client={client}
        workspaceId={workspaceId}
        choices={choices()}
        onChange={setChoices}
      />
      <MessageComposer
        agents={[]}
        artifacts={[]}
        channelId={channelId}
        draft={draft()}
        onDraftChange={setDraft}
        submissionContext={leadRequestedChoicesKey(choices())}
        onSubmit={async (submission) => {
          const requestedModelSelections = await resolver.resolve(
            workspaceId,
            submission.idempotencyKey,
            choices(),
            () => true
          )
          setRequested(JSON.stringify(requestedModelSelections ?? null))
          const response = await client.createMessage(workspaceId, channelId, {
            ...submission,
            leadTurn: true,
            ...(requestedModelSelections ? { requestedModelSelections } : {}),
          })
          const admittedIntentId = response.leadTurn?.intentId
          if (admittedIntentId) setIntentId(admittedIntentId)
          return { clearDraft: true }
        }}
      />
      <Show when={intentId()}>
        {(id) => (
          <>
            <p aria-label="Intent ID">{id()}</p>
            <LeadTurnControls
              client={client}
              workspaceId={workspaceId}
              channelId={channelId}
              audienceEpoch={0}
              onTimelineChange={() => void refreshTimeline()}
            />
          </>
        )}
      </Show>
      <p aria-label="Requested role selections">{requested()}</p>
      <p aria-label="Conversation timeline">{JSON.stringify(timeline())}</p>
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
