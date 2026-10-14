import '../../src/start/globals.css'
import { AgentHqApiClient, ApiClientError, type ApiAddressedTurn } from '@adea-ai/api-client'
import { AgentHqQueryProvider } from '@adea-ai/data'
import type { AgentSummary, ChannelSummary, MessageSummary } from '@adea-ai/types'
import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { ConversationSurface } from '../../../../packages/workspace-ui/src/conversation-surface'

/**
 * A group conversation over an in-page stand-in for the addressed-turn routes. The stand-in keeps the
 * server's rules that the UI depends on (one turn per message, Agent and revision; only the lead is
 * dispatched; a newer human message supersedes live turns; cancel is idempotent) and exposes switches
 * the browser test pulls: a lost response, an answer, a newer message, and an unreadable replay.
 */
const workspaceId = '11111111-0000-4000-8000-0000000000a1'
const guestWorkspaceId = '22222222-0000-4000-8000-0000000000b2'
const channelId = '33333333-0000-4000-8000-0000000000c3'
const ariaId = '44444444-0000-4000-8000-0000000000d4'
const guestId = '55555555-0000-4000-8000-0000000000e5'
const userId = 'user-1'
const now = new Date().toISOString()

const channel: ChannelSummary = {
  createdAt: now,
  id: channelId,
  isPrimaryProjectChannel: false,
  kind: 'group',
  lifecycleState: 'active',
  participants: [
    { kind: 'user', userId },
    { agentId: ariaId, kind: 'agent' },
    { agentId: guestId, kind: 'agent' },
  ],
  sortOrder: 1,
  title: 'Launch review',
  updatedAt: now,
  version: 1,
  visibility: 'participants',
  workspaceId,
}
const aria: AgentSummary = {
  createdAt: now,
  id: ariaId,
  lifecycleState: 'active',
  name: 'Aria',
  presentationMetadata: {},
  profile: { id: 'aria', state: 'available', version: '1' },
  updatedAt: now,
  workspaceId,
}

type Harness = {
  answer: (turnId: string) => void
  calls: { address: number; cancel: number; list: number; mentions: string[][]; messages: number }
  dropNextAddressResponse: () => void
  /** The next message commits but its response is lost, so the composer retries it. */
  dropNextMessageResponse: () => void
  failReplay: (value: boolean) => void
  /** The server stops listing every turn, as for a reader whose audience was withdrawn. */
  hideTurns: (value: boolean) => void
  /** Reads answer with the uniform 404, as for a reader whose access was revoked. */
  revokeReader: (value: boolean) => void
  /** The next address response is delayed until `releaseAddress` runs. */
  holdAddress: () => void
  releaseAddress: () => void
  humanMessage: (text: string) => void
  turns: () => ApiAddressedTurn[]
}
declare global {
  interface Window {
    addressingHarness: Harness
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { 'cache-control': 'private, no-store' }, status })

function build() {
  const messages: MessageSummary[] = []
  const turns: ApiAddressedTurn[] = []
  const calls = { address: 0, cancel: 0, list: 0, mentions: [] as string[][], messages: 0 }
  let sequence = 0
  let tick = 0
  let dropAddress = false
  let dropMessage = false
  let replayFails = false
  let turnsHidden = false
  let readerRevoked = false
  let addressGate: { promise: Promise<void>; release: () => void } | undefined
  const stamp = () => new Date(Date.now() + tick++).toISOString()
  const message = (sender: MessageSummary['sender'], bodyText: string): MessageSummary => {
    sequence += 1
    const createdAt = stamp()
    const created: MessageSummary = {
      artifactIds: [],
      bodyText,
      channelId,
      createdAt,
      deleted: false,
      id: `66666666-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      mentions: [],
      sender,
      sequence,
      updatedAt: createdAt,
      version: 0,
      workspaceId,
    }
    messages.push(created)
    return created
  }
  const supersedeLive = () => {
    for (const turn of turns)
      if (turn.state === 'claimed' || turn.state === 'dispatching')
        Object.assign(turn, { state: 'superseded', updatedAt: stamp() })
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(`http://harness${input}`, init)
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api/, '')
    if (path === '/workspaces')
      return json([
        { id: workspaceId, name: 'Acme' },
        { id: guestWorkspaceId, name: 'Globex' },
      ])
    const cancel = path.match(/\/turns\/([^/]+)\/cancel$/)
    if (cancel) {
      calls.cancel += 1
      const turn = turns.find(({ id }) => id === cancel[1])
      if (!turn) return json({ code: 'unavailable' }, 404)
      const held = turn.state === 'dispatching'
      if (turn.state === 'claimed' || turn.state === 'dispatching')
        Object.assign(turn, { state: 'cancelled', updatedAt: stamp() })
      return json({ runtimeCancelRequested: held, turn })
    }
    if (path.endsWith('/turns') && request.method === 'GET') {
      calls.list += 1
      if (readerRevoked) return json({ code: 'unavailable', message: 'Unavailable' }, 404)
      if (replayFails) return json({ code: 'turns_read_failed', message: 'retry' }, 503)
      return json({ nextAfter: null, turns: turnsHidden ? [] : turns })
    }
    if (path.endsWith('/turns') && request.method === 'POST') {
      calls.address += 1
      const body = (await request.json()) as {
        agentId: string
        dispatchRevision: number
        triggerMessageId: string
      }
      const causalId = `turn:${body.triggerMessageId}:${body.agentId}:${body.dispatchRevision}`
      const respond = async (created: boolean, turn: ApiAddressedTurn, dispatch: string) => {
        if (addressGate) await addressGate.promise
        if (dropAddress) {
          dropAddress = false
          throw new TypeError('Failed to fetch')
        }
        return json({ created, dispatch, turn }, created ? 201 : 200)
      }
      const held = turns.find((turn) => turn.causalId === causalId)
      if (held) return respond(false, held, held.dispatched ? 'admitted' : 'not_lead')
      const lead = body.agentId === ariaId
      const home = lead ? workspaceId : guestWorkspaceId
      const turn: ApiAddressedTurn = {
        addressedLabel: `${home}:${body.agentId}`,
        addresserUserId: userId,
        agentId: body.agentId,
        budget: { maxDepth: 2, maxTurns: 8 },
        causalId,
        channelId,
        createdAt: stamp(),
        depth: 0,
        dispatchRevision: body.dispatchRevision,
        dispatched: lead,
        id: `77777777-0000-4000-8000-${String(turns.length + 1).padStart(12, '0')}`,
        leadTurnIntentId: lead ? 'intent-1' : null,
        parentTurnId: null,
        responseMessageId: null,
        state: lead ? 'dispatching' : 'claimed',
        triggerMessageId: body.triggerMessageId,
        updatedAt: stamp(),
      }
      turns.push(turn)
      return respond(true, turn, lead ? 'admitted' : 'not_lead')
    }
    return json({ code: 'not_found' }, 404)
  }

  const client = new AgentHqApiClient({ baseUrl: '/api', fetchImpl })
  client.listMessages = async () => ({ messages: [...messages] })
  // The message route's own rule: a repeated Idempotency-Key with the same payload answers the stored
  // message, and with a different payload is refused.
  const stored = new Map<string, { fingerprint: string; message: MessageSummary }>()
  client.createMessage = async (_workspace, _channel, input) => {
    const sent = (input.mentions ?? []).map((mention) =>
      'agentId' in mention ? mention.agentId : ''
    )
    calls.mentions.push(sent)
    const fingerprint = JSON.stringify([input.bodyText, sent])
    const prior = stored.get(input.idempotencyKey)
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new ApiClientError(
          'Idempotency key reused with a different request',
          409,
          'idempotency_conflict'
        )
      return { message: prior.message }
    }
    const created = message({ kind: 'user', userId }, input.bodyText ?? '')
    stored.set(input.idempotencyKey, { fingerprint, message: created })
    calls.messages += 1
    supersedeLive()
    if (dropMessage) {
      dropMessage = false
      throw new TypeError('Failed to fetch')
    }
    return { message: created }
  }

  const harness: Harness = {
    answer: (turnId) => {
      const turn = turns.find(({ id }) => id === turnId)
      if (!turn) return
      const reply = message({ agentId: turn.agentId, kind: 'agent' }, 'Here is my answer.')
      Object.assign(turn, { responseMessageId: reply.id, state: 'responded', updatedAt: stamp() })
    },
    calls,
    dropNextAddressResponse: () => {
      dropAddress = true
    },
    dropNextMessageResponse: () => {
      dropMessage = true
    },
    failReplay: (value) => {
      replayFails = value
    },
    holdAddress: () => {
      addressGate = Promise.withResolvers<void>()
      addressGate = { promise: addressGate.promise, release: addressGate.resolve }
    },
    releaseAddress: () => {
      addressGate?.release()
      addressGate = undefined
    },
    revokeReader: (value) => {
      readerRevoked = value
    },
    hideTurns: (value) => {
      turnsHidden = value
    },
    humanMessage: (text) => {
      message({ kind: 'user', userId }, text)
      supersedeLive()
    },
    turns: () => turns,
  }
  window.addressingHarness = harness
  return client
}

function Harness() {
  const client = build()
  const [draft, setDraft] = createSignal('')
  return (
    <AgentHqQueryProvider>
      {createComponent(ConversationSurface, {
        agents: [aria],
        artifacts: [],
        channel,
        client,
        currentUserId: userId,
        get draft() {
          return draft()
        },
        onDraftChange: setDraft,
        onMarkRead: async () => {},
        onMarkThreadRead: async () => {},
        onMarkThreadUnread: async () => {},
        onMarkUnread: async () => {},
        onOpenDetails: () => {},
        onOpenSearch: () => {},
        onOpenTask: () => {},
        onThreadChange: () => {},
        onThreadDraftChange: () => {},
        searchTargetMessageId: null,
        tasks: [],
        threadDraft: '',
        threadRootMessageId: null,
        workspaceId,
      })}
    </AgentHqQueryProvider>
  )
}

render(() => <Harness />, document.getElementById('harness-root')!)
