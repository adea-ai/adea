import {
  ChatView,
  createFirstRunRuntimePort,
  FirstRunOnboarding,
  DevWorkspaceSidebar,
  devBindingsFromProjection,
  resolveDevSelection,
} from '@adea-ai/dev-view/chat'
import type { DesktopTeamChat } from './workspace-navigation'
import type {
  ChatConversation,
  ChatConversationModel,
  DevWorkspaceNavHost,
  FirstRunFacts,
  HandoffLeadAgent,
  HandoffLeadTurn,
} from '@adea-ai/dev-view/chat'
import { resolveLeadHandoffSupply } from '../lib/lead-handoff-supply'
import type {
  DevProjectNames,
  DevRuntimeService,
  DevWorkspaceProjection,
} from '@adea-ai/dev-view/platform'
import type {
  CanonicalRuntimeBinding,
  SharedDevUtilityOwner,
} from '@adea-ai/dev-view/utility-owner'
import { buildDevCommand } from '@adea-ai/dev-view/browser'
import type { Scope } from '@adea-ai/types/dev-runtime'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from 'solid-js'

import { useWorkspaceState, workspaceStore, wideViewportAtLoad } from '@adea-ai/state'
import { AlertCircle } from 'lucide-solid'
import { Button } from '@adea-ai/ui/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyMedia } from '@adea-ai/ui/components/ui/empty'
import '@adea-ai/app-ui/dev-view.css'

import {
  createDesktopChatLifecycleFence,
  createDesktopChatDraftChangeHandler,
  createFirstRunConversationHandler,
  type DesktopChatModelHost,
} from '../lib/desktop-chat-host'
import { bindDesktopChatPresentation } from '../lib/desktop-chat-presentation'
import { resolveDesktopFirstRun, type DesktopFirstRunWorktree } from '../lib/desktop-first-run-chat'

type WorktreePage = Readonly<{ items: readonly DesktopFirstRunWorktree[] }>

export type DesktopFirstRunChatProps = Readonly<{
  sidebarOpener?: () => HTMLElement | undefined
  archiveAction?: JSX.Element
  client: AgentHqApiClient
  fallback: JSX.Element
  onOpenDev(): void
  onSignIn(): void | Promise<void>
  runtime: DevRuntimeService
  modelHost: DesktopChatModelHost
  utilityOwner?: SharedDevUtilityOwner
  /** Explicit runtime authority handoff for the shared utility host. */
  onCanonicalConversation?(binding: CanonicalRuntimeBinding | undefined): void
  temporary: boolean
  workspaceId: string
  /** Cloud project names keyed by project id; absent names show the short id. */
  projectNames?: DevProjectNames
  /**
   * The shell's native folder picker for the sidebar's add surface; absent on
   * hosts without one (the typed path input is the fallback there).
   */
  pickFolder?: () => Promise<string | null | undefined>
  /** The cloud workspace the shared sidebar renders (ADR 0011). */
  workspaceNav?: DevWorkspaceNavHost
  /** The team conversation or Agents surface opened from the sidebar's global sections. */
  teamChat?: DesktopTeamChat
}>

type ReadyState = Readonly<{
  model: ChatConversationModel
  scope: Scope
  projection: DevWorkspaceProjection
}> &
  (
    | Readonly<{ kind: 'returning' }>
    | Readonly<{
        kind: 'first-run'
        facts: FirstRunFacts
        port: ReturnType<typeof createFirstRunRuntimePort>
      }>
  )

/**
 * Desktop Chat attaches returning sessions from the authenticated registry.
 * Only the empty-runtime path needs onboarding worktrees, AgentProfiles and
 * model-access facts. Missing runtime authority preserves the team fallback.
 */
export function DesktopFirstRunChat(props: DesktopFirstRunChatProps): JSX.Element {
  const [ready, setReady] = createSignal<ReadyState>()
  const [conversation, setConversation] = createSignal<ChatConversation>()
  const lifecycle = createDesktopChatLifecycleFence()
  const selectedProject = useWorkspaceState((state) => state.selectedDevProjectId)
  const selectedSession = useWorkspaceState((state) => state.selectedRuntimeSessionId)
  const sidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const [attachmentError, setAttachmentError] = createSignal('')
  const [announcement, setAnnouncement] = createSignal('')
  // Names come from the host's cloud project list; an explicit map wins.
  const projectNames = createMemo<DevProjectNames | undefined>(
    () =>
      props.projectNames ??
      (props.workspaceNav?.projects
        ? new Map(props.workspaceNav.projects.map((project) => [project.id, project.name]))
        : undefined)
  )
  const reloadProjection = async () => {
    const current = ready()
    if (!current || !props.runtime.projection) return
    const request = lifecycle.current()
    const projection = await props.runtime.projection(current.scope).catch(() => undefined)
    if (!projection || !lifecycle.isCurrent(request) || ready() !== current) return
    setReady({ ...current, projection })
  }
  const [retry, setRetry] = createSignal(0)
  let attachment = 0
  const selection = createMemo(() => {
    const state = ready()
    if (!state || state.kind !== 'returning') return undefined
    return resolveDevSelection({
      scope: state.scope,
      projects: state.projection.projects.map((project) => ({
        id: project.id,
        sessions: project.sessions.map((session) => ({
          id: session.id,
          generation: session.generation,
          archived: session.state === 'archived',
        })),
      })),
      requestedProjectId: selectedProject(),
      requestedSessionId: selectedSession(),
    })
  })

  const conversationSelectionId = () => {
    const selected = selection()
    return selected && selected.status !== 'empty' ? selected.runtimeSessionId : undefined
  }

  // Each selection owns its async attach; a scope replacement, unmount or
  // later selection rejects the older response without opening a transcript.
  createEffect(() => {
    const state = ready()
    const selected = selection()
    void retry()
    if (!state || state.kind !== 'returning' || !selected) return
    if (selected.status !== 'empty' && selected.runtimeSessionId) {
      const active = conversation()
      const canonical = state.projection.projects
        .find((project) => project.id === selected.projectId)
        ?.sessions.find((session) => session.id === selected.runtimeSessionId)
      if (
        active &&
        canonical &&
        canonical.state !== 'archived' &&
        active.runtimeSessionId === selected.runtimeSessionId &&
        active.projectId === selected.projectId &&
        (canonical.generation === undefined || active.generation === canonical.generation) &&
        sameScope(active.scope, state.scope)
      )
        return
    }
    const token = ++attachment
    const request = lifecycle.current()
    setConversation(undefined)
    props.onCanonicalConversation?.(undefined)
    setAttachmentError('')
    onCleanup(() => {
      attachment += 1
    })
    if (selected.status === 'empty' || !selected.runtimeSessionId) return
    const store = workspaceStore.getState()
    if (store.selectedDevProjectId !== selected.projectId)
      store.setSelectedDevProjectId(selected.projectId)
    if (store.selectedRuntimeSessionId !== selected.runtimeSessionId)
      store.setSelectedRuntimeSessionId(selected.runtimeSessionId)
    void state.model
      .attach(selected.runtimeSessionId)
      .then((next) => {
        if (token !== attachment || !lifecycle.isCurrent(request) || ready() !== state) return
        const canonical = state.projection.projects
          .find((project) => project.id === selected.projectId)
          ?.sessions.find((session) => session.id === selected.runtimeSessionId)
        if (
          !canonical ||
          canonical.state === 'archived' ||
          next.runtimeSessionId !== selected.runtimeSessionId ||
          next.projectId !== selected.projectId ||
          (canonical.generation !== undefined && next.generation !== canonical.generation) ||
          !sameScope(next.scope, state.scope)
        ) {
          setAttachmentError('This conversation is unavailable. Retry or select another session.')
          return
        }
        state.model.switchTo(next.runtimeSessionId)
        setConversation(next)
        if (Number.isSafeInteger(next.generation) && next.generation > 0)
          props.onCanonicalConversation?.({
            scope: next.scope,
            projectId: next.projectId,
            runtimeSessionId: next.runtimeSessionId,
            sessionGeneration: next.generation,
            worktreeId: canonical.worktreeId,
          })
      })
      .catch(() => {
        if (token !== attachment || !lifecycle.isCurrent(request) || ready() !== state) return
        setAttachmentError('This conversation is unavailable. Retry or select another session.')
      })
  })

  let seenArchiveRestoreRevision = props.utilityOwner?.archiveRestoreRevision() ?? 0
  createEffect(() => {
    const revision = props.utilityOwner?.archiveRestoreRevision()
    if (revision === undefined || revision === seenArchiveRestoreRevision) return
    seenArchiveRestoreRevision = revision
    const current = ready()
    if (current?.kind === 'returning' && props.runtime.projection) {
      const context = props.utilityOwner?.context()
      const scope = props.runtime.preferenceScope?.()
      const runtimeStatus = props.runtime.state().status
      if (
        !scope ||
        !sameScope(scope, current.scope) ||
        runtimeStatus !== 'ready' ||
        (context &&
          (context.view !== 'chat' || !context.scope || !sameScope(context.scope, current.scope)))
      )
        return
      const request = lifecycle.current()
      void props.runtime.projection(current.scope).then(
        (projection) => {
          const latestScope = props.runtime.preferenceScope?.()
          const latestContext = props.utilityOwner?.context()
          if (
            !lifecycle.isCurrent(request) ||
            ready() !== current ||
            !latestScope ||
            !sameScope(latestScope, current.scope) ||
            props.runtime.state().status !== runtimeStatus ||
            (context && latestContext?.revision !== context.revision)
          )
            return
          setReady({ ...current, projection })
        },
        () => undefined
      )
      return
    }
    const request = lifecycle.begin()
    setReady(undefined)
    setConversation(undefined)
    props.onCanonicalConversation?.(undefined)
    void load(request).then((next) => {
      if (lifecycle.isCurrent(request) && next) setReady(next)
    })
  })

  // Only a mounted canonical Chat conversation is reported. Conventional
  // workspace/team chat remains a separate domain and never fabricates a
  // runtime session selection.
  bindDesktopChatPresentation('chat', () => conversation()?.runtimeSessionId)

  // Workspace-lead handoff supply (#1177): resolved from canonical
  // services for the active conversation's workspace — the designated
  // lead agent, its direct channel turn, and the canonical cancel path.
  // Keyed on workspace+session+task identity (not object identity) so
  // draft edits and same-session refreshes never refetch; the monotonic
  // epoch orders overlapping resolutions and cancels so an older response
  // can never overwrite newer facts for the same session. A late
  // resolution for a superseded selection is dropped by the lifecycle
  // fence first.
  const [leadSupply, setLeadSupply] = createSignal<{
    turn?: HandoffLeadTurn
    agent?: HandoffLeadAgent
  }>({})
  let leadResolution = 0
  let lastLeadKey = ''
  const advanceLeadEpoch = (): number => {
    leadResolution += 1
    return leadResolution
  }
  createEffect(() => {
    const activeConversation = conversation()
    if (!activeConversation) return
    const workspaceId = activeConversation.scope.workspaceId
    const sessionId = activeConversation.runtimeSessionId
    const taskId = activeConversation.taskId
    const key = `${workspaceId}${sessionId}${taskId ?? ''}`
    if (key === lastLeadKey) return
    lastLeadKey = key
    const request = lifecycle.current()
    const epoch = advanceLeadEpoch()
    setLeadSupply({})
    void resolveLeadHandoffSupply(props.client, workspaceId, taskId).then((resolution) => {
      if (!lifecycle.isCurrent(request)) return
      if (leadResolution !== epoch) return
      if (conversation()?.runtimeSessionId !== sessionId) return
      if (resolution.status !== 'resolved') {
        setLeadSupply(resolution.leadAgent ? { agent: resolution.leadAgent } : {})
        return
      }
      setLeadSupply({ turn: resolution.leadTurn, agent: resolution.leadAgent })
    })
  })

  const cancelWorkspaceLead = async (): Promise<void> => {
    const supply = leadSupply()
    const turn = supply.turn
    const activeConversation = conversation()
    if (!turn || !activeConversation) return
    const workspaceId = activeConversation.scope.workspaceId
    const request = lifecycle.current()
    // The cancel is newer than any in-flight read: advance the epoch so a
    // late resolution cannot overwrite the receipt applied below.
    const epoch = advanceLeadEpoch()
    const response = await props.client.cancelLeadTurn(workspaceId, turn.intentId)
    if (!lifecycle.isCurrent(request)) return
    if (leadResolution !== epoch) return
    if (conversation()?.runtimeSessionId !== activeConversation.runtimeSessionId) return
    // Refresh local facts from the canonical cancel receipt instead of
    // refetching: the response carries the turn's terminal state.
    const next = response.leadTurn
    setLeadSupply((previous) => ({
      ...previous,
      turn: {
        intentId: next.intentId,
        agentId: turn.agentId,
        ...(next.dispatchId !== undefined ? { dispatchId: next.dispatchId } : {}),
        state: next.state as HandoffLeadTurn['state'],
        canCancel: false,
      },
    }))
  }

  createEffect(() => {
    // These reads make auth/workspace changes start a fresh scoped load even
    // when the parent keeps the Chat entry mounted across a route switch.
    void props.client
    void props.modelHost
    void props.runtime
    void props.temporary
    void props.workspaceId
    setReady(undefined)
    setConversation(undefined)
    props.onCanonicalConversation?.(undefined)
    const request = lifecycle.begin()
    void load(request).then((next) => {
      if (lifecycle.isCurrent(request) && next) setReady(next)
    })
    onCleanup(() => {
      lifecycle.invalidate()
      props.onCanonicalConversation?.(undefined)
    })
  })

  async function load(request: number): Promise<ReadyState | undefined> {
    const runtime = props.runtime
    const modelHost = props.modelHost
    const client = props.client
    const workspaceId = props.workspaceId
    const temporary = props.temporary
    await runtime.ready?.catch(() => undefined)
    if (!lifecycle.isCurrent(request)) return undefined
    const scope = runtime.preferenceScope?.()
    if (!scope || scope.workspaceId !== workspaceId || runtime.state().status !== 'ready')
      return undefined
    try {
      const model = modelHost.get(scope)
      const projection = await runtime.projection?.(scope)
      if (!projection || !lifecycle.isCurrent(request)) return undefined
      if (
        projection.projects.some((project) =>
          project.sessions.some((session) => session.state !== 'archived')
        )
      )
        return { kind: 'returning', model, scope, projection }
      const port = createFirstRunRuntimePort(runtime, scope, model)
      const [worktreePage, workspace, managedPi] = await Promise.all([
        readWorktrees(runtime, scope),
        client.getWorkspace(workspaceId),
        port.readManagedPi(),
      ])
      if (!workspace) return undefined
      const resolution = resolveDesktopFirstRun({
        temporary,
        managedPi,
        projection,
        worktrees: worktreePage.items,
        agents: workspace.agents,
      })
      const boundPort = createFirstRunRuntimePort(runtime, scope, model, resolution.context)
      return {
        kind: 'first-run',
        projection,
        facts: resolution.facts,
        model,
        port: boundPort,
        scope,
      }
    } catch {
      // A missing or refused authority must not become a synthetic onboarding
      // state. The normal Chat surface remains the truthful fallback.
      return undefined
    }
  }

  return (
    <Show when={ready()} fallback={props.fallback}>
      {(state) => {
        const request = lifecycle.current()
        return (
          <div class="dev-workspace dev-workspace--chat">
            <div class="dev-workspace__body">
              <DevWorkspaceSidebar
                runtime={props.runtime}
                scope={state().scope}
                bindings={devBindingsFromProjection(state().projection, projectNames())}
                host={props.workspaceNav}
                projectNames={projectNames()}
                selectedProjectId={selectedProject() ?? ''}
                selectedSessionId={selectedSession() ?? ''}
                compactOpen={sidebarOpen()}
                onOpenChange={(open) => workspaceStore.getState().setMobileSidebarOpen(open)}
                wideViewportAtLoad={wideViewportAtLoad}
                restoreFocusRef={props.sidebarOpener}
                navigationLabel="Chat workspaces"
                footer={props.archiveAction}
                pickFolder={props.pickFolder}
                onSelectSession={(projectId, sessionId) => {
                  props.teamChat?.onRuntimeSelection()
                  const store = workspaceStore.getState()
                  if (store.selectedDevProjectId !== projectId)
                    store.setSelectedDevProjectId(projectId)
                  if (sessionId) store.setSelectedRuntimeSessionId(sessionId)
                }}
                onBindingsChanged={reloadProjection}
                announce={setAnnouncement}
              />
              <div class="workspace-runtime-chat">
                <Show when={!props.teamChat?.active()} fallback={props.teamChat?.surface()}>
                  <Show
                    when={conversation()}
                    fallback={
                      <Show
                        when={state().kind === 'first-run'}
                        fallback={
                          // The column's pending and unavailable states share
                          // the published Empty treatment: centred in the chat
                          // column like its other states, instead of bare text
                          // pinned to the top-left.
                          <Empty class="h-full" role="status">
                            <Show
                              when={attachmentError()}
                              fallback={
                                <EmptyDescription>
                                  {selection()?.status === 'empty' || !conversationSelectionId()
                                    ? 'Select a project with a conversation.'
                                    : 'Opening conversation…'}
                                </EmptyDescription>
                              }
                            >
                              <EmptyMedia variant="icon">
                                <AlertCircle aria-hidden="true" />
                              </EmptyMedia>
                              <EmptyDescription>{attachmentError()}</EmptyDescription>
                              <EmptyContent>
                                <Button
                                  type="button"
                                  onClick={() => setRetry((value) => value + 1)}
                                >
                                  Retry conversation
                                </Button>
                              </EmptyContent>
                            </Show>
                          </Empty>
                        }
                      >
                        {(() => {
                          const onboarding = state()
                          if (onboarding.kind !== 'first-run') return undefined
                          return (
                            <FirstRunOnboarding
                              facts={onboarding.facts}
                              port={onboarding.port}
                              onAction={async (kind) => {
                                if (kind === 'sign_in') return props.onSignIn()
                                if (kind === 'add_project' || kind === 'set_up_agent')
                                  props.onOpenDev()
                                if (kind === 'retry_access' || kind === 'update_app') {
                                  const nextRequest = lifecycle.begin()
                                  setReady(undefined)
                                  setConversation(undefined)
                                  const next = await load(nextRequest)
                                  if (lifecycle.isCurrent(nextRequest) && next) setReady(next)
                                }
                              }}
                              onConversation={createFirstRunConversationHandler({
                                currentModel: () => ready()?.model,
                                getModel: () => onboarding.model,
                                lifecycle,
                                onAttached: (next) => {
                                  setConversation(next)
                                  const store = workspaceStore.getState()
                                  store.setSelectedDevProjectId(next.projectId)
                                  store.setSelectedRuntimeSessionId(next.runtimeSessionId)
                                  void props.runtime
                                    .projection?.(onboarding.scope)
                                    .then((projection) => {
                                      if (
                                        !lifecycle.isCurrent(request) ||
                                        ready()?.model !== onboarding.model
                                      )
                                        return
                                      setReady({
                                        kind: 'returning',
                                        model: onboarding.model,
                                        scope: onboarding.scope,
                                        projection,
                                      })
                                    })
                                    .catch(() => undefined)
                                },
                                request,
                              })}
                            />
                          )
                        })()}
                      </Show>
                    }
                  >
                    {(active) => (
                      <ChatView
                        conversation={active()}
                        model={state().model}
                        onJumpToTerminal={props.onOpenDev}
                        // #1177 production handoff supply: the view derives from
                        // the live conversation plus canonical workspace-lead
                        // facts resolved above; session-stop and reconnect
                        // stay model-backed, and lead cancellation runs the
                        // canonical lead-turn cancel path.
                        handoff={{
                          leadTurn: leadSupply().turn,
                          leadAgent: leadSupply().agent,
                        }}
                        onLeadStop={leadSupply().turn ? cancelWorkspaceLead : undefined}
                        readingPosition={props.modelHost.readingPosition(state().scope, active())}
                        onReadingPositionChange={(identity, position) => {
                          if (!lifecycle.isCurrent(request)) return
                          props.modelHost.setReadingPosition(state().scope, identity, position)
                        }}
                        draftRevision={props.modelHost.draftRevision(
                          state().scope,
                          active().runtimeSessionId
                        )}
                        onDraftChange={createDesktopChatDraftChangeHandler({
                          scope: state().scope,
                          modelHost: props.modelHost,
                          lifecycle,
                          request,
                          onConversationChange: setConversation,
                        })}
                      />
                    )}
                  </Show>
                </Show>
              </div>
            </div>
            <p class="sr-only" aria-live="polite">
              {announcement()}
            </p>
          </div>
        )
      }}
    </Show>
  )
}

async function readWorktrees(runtime: DevRuntimeService, scope: Scope): Promise<WorktreePage> {
  const reply = await runtime.execute(
    buildDevCommand({
      operation: 'dev.worktree.list',
      scope,
      body: { archived: false, limit: 50 },
    })
  )
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.value as WorktreePage
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeNodeId === right.runtimeNodeId
  )
}
