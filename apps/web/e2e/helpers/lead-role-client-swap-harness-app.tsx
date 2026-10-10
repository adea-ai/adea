import './lead-payer-journey-harness.css'
import { AgentHqApiClient, type ApiLeadTurnStatus } from '@adea-ai/api-client'
import { AgentHqQueryProvider } from '@adea-ai/data'
import type { AgentSummary, ChannelSummary, MessageSummary } from '@adea-ai/types'
import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Button } from '@adea-ai/ui/components/ui/button'
import { ConversationSurface } from '../../../../packages/workspace-ui/src/conversation-surface'

const workspaceId = 'workspace-fixture'
const channelId = 'lead-topic'
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
} as const
const now = new Date().toISOString()
const channel: ChannelSummary = {
  agentId: 'lead-agent',
  createdAt: now,
  id: channelId,
  isPrimaryProjectChannel: false,
  kind: 'direct_agent',
  lifecycleState: 'active',
  participants: [{ kind: 'agent', agentId: 'lead-agent' }],
  sortOrder: 1,
  title: 'Personal lead',
  updatedAt: now,
  version: 1,
  visibility: 'workspace',
  workspaceId,
}
const lead: AgentSummary = {
  isWorkspaceLead: true,
  createdAt: now,
  id: 'lead-agent',
  lifecycleState: 'active',
  name: 'Personal lead',
  presentationMetadata: {},
  profile: { id: 'lead-profile', state: 'available', version: '1' },
  updatedAt: now,
  workspaceId,
}

type Counters = {
  oldLists: number
  oldResolves: number
  replacementLists: number
  replacementResolves: number
  messageClients: string[]
}

function makeClient(
  owner: 'old' | 'replacement',
  counters: Counters,
  heldOldResolution: () => Promise<void>,
  touch: () => void,
  setLatest: (turn: ApiLeadTurnStatus) => void
) {
  const letter = owner === 'old' ? 'a' : 'c'
  let latestTurn: ApiLeadTurnStatus | undefined
  const client = new AgentHqApiClient({ baseUrl: '/api', fetchImpl: async () => Response.json({}) })
  const historyMessage: MessageSummary = {
    artifactIds: [],
    bodyText: 'Existing history',
    channelId,
    createdAt: now,
    deleted: false,
    id: 'history-message',
    mentions: [],
    sender: { kind: 'user', userId: 'current-user' },
    sequence: 1,
    updatedAt: now,
    version: 0,
    workspaceId,
  }
  client.listMessages = async () => ({ messages: [historyMessage] })
  client.listModelConnections = async () => {
    if (owner === 'old') counters.oldLists++
    else counters.replacementLists++
    touch()
    return {
      availability: 'available',
      target,
      canManage: false,
      connections: [
        {
          connectionRef: `mconn_${letter.repeat(32)}`,
          revision: 1,
          provider: 'scripted',
          accountRef: `account-${owner}`,
          authKind: 'api_key',
          fundingSource: 'byo_api',
          status: 'active',
          models: [
            {
              providerModel: `model-${owner}`,
              readiness: { ready: true, reasonCode: 'READY', remedy: null },
            },
          ],
        },
      ],
    }
  }
  client.resolveWorkspaceModelSelection = async (_workspace, input) => {
    if (owner === 'old') counters.oldResolves++
    else counters.replacementResolves++
    touch()
    if (owner === 'old') await heldOldResolution()
    return {
      selection: {
        selectionRef: `msel_${letter.repeat(32)}`,
        selectionRevision: 1,
        connectionRef: input.override!.connectionRef,
        provider: 'scripted',
        providerModel: input.override!.providerModel,
        target,
        authKind: 'api_key',
        fundingSource: 'byo_api',
      },
    }
  }
  client.createMessage = async (_workspace, _channel, input) => {
    counters.messageClients.push(owner)
    touch()
    const createdAt = new Date().toISOString()
    const message: MessageSummary = {
      artifactIds: [],
      bodyText: input.bodyText ?? '',
      channelId,
      createdAt,
      deleted: false,
      id: `message-${owner}-${counters.messageClients.length}`,
      mentions: [],
      sender: { kind: 'user', userId: 'current-user' },
      sequence: counters.messageClients.length,
      updatedAt: createdAt,
      version: 0,
      workspaceId,
    }
    const leadTurn = input.leadTurn
      ? {
          schemaVersion: 'pi-lead-intent/v1' as const,
          intentId: `intent-${owner}`,
          messageId: message.id,
          dispatchKey: `lead-turn:${message.id}`,
          state: 'blocked' as const,
          reasonCode: 'ADMISSION_SERVICE_UNAVAILABLE' as const,
        }
      : undefined
    if (leadTurn) {
      latestTurn = {
        schemaVersion: 'adea-lead-turn/v1',
        intentId: leadTurn.intentId,
        messageId: message.id,
        state: 'blocked',
        availability: 'unavailable',
      }
      setLatest(latestTurn)
    }
    return { message, ...(leadTurn ? { leadTurn } : {}) }
  }
  client.getChannelLeadTurn = async () => ({ leadTurn: null })
  client.getLeadTurnStatus = async () => ({ leadTurn: latestTurn! })
  return client
}

function Harness() {
  const [client, setClient] = createSignal<AgentHqApiClient>()
  const counters: Counters = {
    oldLists: 0,
    oldResolves: 0,
    replacementLists: 0,
    replacementResolves: 0,
    messageClients: [],
  }
  const [observedCounters, setObservedCounters] = createSignal<Counters>({
    ...counters,
    messageClients: [],
  })
  const touch = () =>
    setObservedCounters({ ...counters, messageClients: [...counters.messageClients] })
  const [draft, setDraft] = createSignal('Retained draft')
  const [latestTurn, setLatestTurn] = createSignal<ApiLeadTurnStatus>()
  let releaseOld!: () => void
  const oldResolution = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  const old = makeClient('old', counters, () => oldResolution, touch, setLatestTurn)
  const replacement = makeClient('replacement', counters, async () => {}, touch, setLatestTurn)
  setClient(old)
  return (
    <AgentHqQueryProvider>
      <Button onClick={() => setClient(replacement)}>Replace signed client</Button>
      <Button onClick={() => releaseOld()}>Release old response</Button>
      {createComponent(ConversationSurface, {
        agents: [lead],
        artifacts: [],
        channel,
        get client() {
          return client()!
        },
        get draft() {
          return draft()
        },
        onDraftChange: setDraft,
        onOpenDetails: () => {},
        onOpenSearch: () => {},
        onOpenTask: () => {},
        onMarkRead: async () => {},
        onMarkThreadRead: async () => {},
        onMarkThreadUnread: async () => {},
        onMarkUnread: async () => {},
        onThreadDraftChange: () => {},
        onThreadChange: () => {},
        searchTargetMessageId: null,
        tasks: [],
        threadDraft: '',
        threadRootMessageId: null,
        workspaceId,
      })}
      <output aria-label="Old resolves">{observedCounters().oldResolves}</output>
      <output aria-label="Old lists">{observedCounters().oldLists}</output>
      <output aria-label="Replacement lists">{observedCounters().replacementLists}</output>
      <output aria-label="Replacement resolves">{observedCounters().replacementResolves}</output>
      <output aria-label="Message post clients">
        {observedCounters().messageClients.join(',')}
      </output>
      <output aria-label="Active client">{client() === old ? 'old' : 'replacement'}</output>
      <output aria-label="Current lead intent">{latestTurn()?.intentId}</output>
    </AgentHqQueryProvider>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
