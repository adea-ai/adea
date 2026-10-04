import '../../src/start/globals.css'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import {
  ChatView,
  buildComposerDecisionRequest,
  DecisionLayerUnavailableError,
  type ChatComposerProps,
  type ChatConversation,
  type ComposerDecisionInputs,
  type DecisionLayerResolution,
  type DecisionLayerOutcome,
  type DecisionResolutionRequest,
} from '@adea-ai/dev-view/chat'
import type { Scope } from '@adea-ai/types/dev-runtime'

const scope: Scope = {
  accountId: '00000000-0000-4000-8000-000000000101',
  workspaceId: '00000000-0000-4000-8000-000000000102',
  runtimeNodeId: '00000000-0000-4000-8000-000000000103',
}

const conversation: ChatConversation = {
  runtimeSessionId: '00000000-0000-4000-8000-000000000104',
  scope,
  projectId: '00000000-0000-4000-8000-000000000105',
  repoId: '00000000-0000-4000-8000-000000000106',
  worktreeId: '00000000-0000-4000-8000-000000000107',
  groupIds: [],
  title: 'Decision seam contract conversation',
  status: 'ready',
  archived: false,
  projection: 'structured',
  generation: 1,
  version: 1,
  draft: '',
  draftBlocks: [],
  events: [],
  retention: { maxEvents: 100, complete: true },
}

const otherConversation: ChatConversation = {
  ...conversation,
  runtimeSessionId: '00000000-0000-4000-8000-000000000108',
  generation: 2,
}

const otherScope: Scope = {
  ...scope,
  workspaceId: '00000000-0000-4000-8000-000000000110',
}

const resolvedDecision: DecisionLayerResolution = {
  schemaVersion: 1,
  requestId: 'req_chat_view_decision_contract',
  workspaceId: scope.workspaceId,
  contractVersion: { major: 1, minor: 0 },
  resolvedAt: '2026-10-03T12:00:01.000Z',
  resolution: {
    harness: { harnessId: 'pi' },
    model: { modelId: 'model-1' },
    skills: { skillVersionIds: [] },
    capabilities: { capabilityNames: [] },
    runtime: {
      runtimeDefinitionId: '00000000-0000-4000-8000-000000000109',
      kind: 'local',
      transport: 'direct-local',
      harnessIds: ['pi'],
      capabilities: [],
    },
    sandbox: { mode: 'managed', effectiveCapabilities: [] },
    contextPackage: { mode: 'none' },
    delegation: { fanOut: 'none', promotion: 'review-required' },
  },
  trace: {},
  diagnostics: [],
  resolutionDigest: `sha256:${'b'.repeat(64)}`,
}

type Readiness = 'none' | 'request-only' | 'consumer-only' | 'ready' | 'deferred'

const requestInputs: ComposerDecisionInputs[] = []
const clientRequests: DecisionResolutionRequest[] = []
const outcomes: Array<Readonly<{ kind: string; status?: string; action?: string }>> = []
const sends: string[] = []
const pendingResolutions: Array<(value: unknown) => void> = []
const pendingSends: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
let deferNextSend = false
let failNextSend = false
let resolvedCallbacks = 0

const decisionRequest: NonNullable<ChatComposerProps['decisionRequest']> = (input) => {
  requestInputs.push(input)
  return buildComposerDecisionRequest({
    caller: { servicePrincipalId: 'adea-desktop' },
    requestId: 'req_chat_view_decision_contract',
    workspaceId: scope.workspaceId,
    projectId: conversation.projectId,
    correlation: { traceId: 'trace_chat_view_decision_contract' },
    requestedAt: '2026-10-03T12:00:00.000Z',
    agentProfile: { profileId: 'profile_chat_view_contract' },
    availableRuntimes: [],
    entitlements: { modelAccess: 'none', grantedCapabilityNames: [] },
    requiredCapabilities: [],
    costLatencyPreference: 'balanced',
    projectDefaults: {},
    profileDefaults: {},
    ...input,
  })
}

const decisionConsumer: NonNullable<ChatComposerProps['decisionConsumer']> = {
  client: {
    resolve: async (request) => {
      clientRequests.push(request)
      if (readiness() === 'deferred')
        return await new Promise<unknown>((resolve) => pendingResolutions.push(resolve))
      throw new DecisionLayerUnavailableError('auth_required', 'Sign in to continue.')
    },
  },
  onResolved: async () => {
    resolvedCallbacks += 1
  },
  onOutcome: (outcome: DecisionLayerOutcome) => {
    outcomes.push(
      outcome.kind === 'failure'
        ? { kind: outcome.kind, status: outcome.status, action: outcome.action }
        : { kind: outcome.kind }
    )
  },
}

const initialReadiness = new URLSearchParams(window.location.search).get(
  'readiness'
) as Readiness | null
const [readiness, setReadiness] = createSignal<Readiness>(initialReadiness ?? 'none')
const [activeConversation, setActiveConversation] = createSignal(conversation)
const steers: string[] = []
const root = document.getElementById('harness-root')
if (!root) throw new Error('Chat decision harness root is missing.')

let disposeChatView: (() => void) | undefined
disposeChatView = render(
  () => (
    <ChatView
      conversation={activeConversation()}
      connected
      autoAttach={false}
      onSend={(text) => {
        sends.push(text)
        if (failNextSend) {
          failNextSend = false
          throw new Error('immediate send failed')
        }
        if (!deferNextSend) return
        deferNextSend = false
        return new Promise<void>((resolve, reject) => pendingSends.push({ resolve, reject }))
      }}
      onSteer={(text) => {
        steers.push(text)
      }}
      decisionRequest={
        readiness() === 'ready' || readiness() === 'request-only' || readiness() === 'deferred'
          ? decisionRequest
          : undefined
      }
      decisionConsumer={
        readiness() === 'ready' || readiness() === 'consumer-only' || readiness() === 'deferred'
          ? decisionConsumer
          : undefined
      }
    />
  ),
  root
)

window.chatViewDecisionHarness = {
  setReadiness,
  setBusy: (busy) =>
    setActiveConversation((active) => ({ ...active, status: busy ? 'active' : 'ready' })),
  setSession: (session) =>
    setActiveConversation(session === 'other' ? otherConversation : conversation),
  setScope: (scopeName) => {
    const active = activeConversation()
    setActiveConversation({ ...active, scope: scopeName === 'other' ? otherScope : scope })
  },
  deferNextSend: () => {
    deferNextSend = true
  },
  failNextSend: () => {
    failNextSend = true
  },
  resolvePendingSend: async () => {
    pendingSends.shift()?.resolve()
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  },
  rejectPendingSend: async () => {
    pendingSends.shift()?.reject(new Error('deferred send failed'))
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  },
  resolvePending: async () => {
    pendingResolutions.shift()?.(resolvedDecision)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  },
  dispose: () => {
    disposeChatView?.()
    disposeChatView = undefined
  },
  report: () => ({
    runtimeSessionId: activeConversation().runtimeSessionId,
    generation: activeConversation().generation,
    workspaceId: activeConversation().scope.workspaceId,
    pendingSends: pendingSends.length,
    pendingResolutions: pendingResolutions.length,
    sends: [...sends],
    steers: [...steers],
    requestInputs: requestInputs.map(({ mode, objective, explicitPins }) => ({
      mode,
      objective,
      explicitPins,
    })),
    clientRequests: clientRequests.map((request) => ({
      contractVersion: request.contractVersion,
      workspaceId: request.workspaceId,
      objective: request.objective,
      explicitPins: request.explicitPins,
    })),
    outcomes: [...outcomes],
    resolvedCallbacks,
  }),
}

declare global {
  interface Window {
    chatViewDecisionHarness: {
      setReadiness(readiness: Readiness): void
      setBusy(busy: boolean): void
      setSession(session: 'initial' | 'other'): void
      setScope(scope: 'initial' | 'other'): void
      deferNextSend(): void
      failNextSend(): void
      resolvePendingSend(): Promise<void>
      rejectPendingSend(): Promise<void>
      resolvePending(): Promise<void>
      dispose(): void
      report(): {
        runtimeSessionId: string
        generation: number
        workspaceId: string
        pendingSends: number
        pendingResolutions: number
        sends: string[]
        steers: string[]
        requestInputs: Array<Pick<ComposerDecisionInputs, 'mode' | 'objective' | 'explicitPins'>>
        clientRequests: Array<
          Pick<
            DecisionResolutionRequest,
            'contractVersion' | 'workspaceId' | 'objective' | 'explicitPins'
          >
        >
        outcomes: Array<{ kind: string; status?: string; action?: string }>
        resolvedCallbacks: number
      }
    }
  }
}
