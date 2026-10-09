import './lead-payer-journey-harness.css'
import { AgentHqApiClient } from '@adea-ai/api-client'
import { AgentHqQueryProvider } from '@adea-ai/data'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Button } from '@adea-ai/ui/components/ui/button'
import { LeadTurnModelChoices } from '../../../../packages/workspace-ui/src/lead-turn-model-choices'
import {
  createLeadModelRequestResolver,
  type LeadRequestedChoices,
} from '../../../../packages/workspace-ui/src/lead-model-request'
import { leadRequestedChoicesKey } from '../../../../packages/workspace-ui/src/request-id'
import { MessageComposer } from '../../../../packages/workspace-ui/src/message-composer'

// Mounted behavior uses scripted metadata/message HTTP; CP and funding are not qualified here.
function Harness() {
  const [choices, setChoices] = createSignal<LeadRequestedChoices>({})
  const [draft, setDraft] = createSignal('Unsent lead question')
  const [saved, setSaved] = createSignal('')
  const [posts, setPosts] = createSignal(0)
  const [resolves, setResolves] = createSignal(0)
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
