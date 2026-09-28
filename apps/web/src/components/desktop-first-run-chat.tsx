import {
  ChatView,
  createFirstRunRuntimePort,
  FirstRunOnboarding,
  DevSidebarNavigation,
  resolveDevSelection,
} from '@adea-ai/dev-view/chat'
import type { ChatConversation, ChatConversationModel, FirstRunFacts } from '@adea-ai/dev-view/chat'
import type { DevRuntimeService, DevWorkspaceProjection } from '@adea-ai/dev-view/platform'
import { buildDevCommand } from '@adea-ai/dev-view/browser'
import type { Scope } from '@adea-ai/types/dev-runtime'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from 'solid-js'

import { useWorkspaceState, workspaceStore } from '@adea-ai/state'
import { Button } from '@adea-ai/ui/components/ui/button'
import '@adea-ai/app-ui/dev-view.css'

import {
  createDesktopChatLifecycleFence,
  createFirstRunConversationHandler,
  type DesktopChatModelHost,
} from '../lib/desktop-chat-host'
import { bindDesktopChatPresentation } from '../lib/desktop-chat-presentation'
import { resolveDesktopFirstRun, type DesktopFirstRunWorktree } from '../lib/desktop-first-run-chat'

type WorktreePage = Readonly<{ items: readonly DesktopFirstRunWorktree[] }>

export type DesktopFirstRunChatProps = Readonly<{
  client: AgentHqApiClient
  fallback: JSX.Element
  onOpenDev(): void
  onSignIn(): void | Promise<void>
  runtime: DevRuntimeService
  modelHost: DesktopChatModelHost
  temporary: boolean
  workspaceId: string
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
  const collapsedGroups = useWorkspaceState((state) => state.collapsedDevGroupIds)
  const collapsedProjects = useWorkspaceState((state) => state.collapsedDevProjectIds)
  const sidebarOpen = useWorkspaceState((state) => state.mobileSidebarOpen)
  const [attachmentError, setAttachmentError] = createSignal('')
  const [retry, setRetry] = createSignal(0)
  let attachment = 0
  const selection = createMemo(() => {
    const state = ready()
    if (!state || state.kind !== 'returning') return undefined
    return resolveDevSelection({
      scope: state.scope,
      projects: state.projection.groups.flatMap((group) =>
        group.projects.map((project) => ({
          id: project.id,
          sessions: project.sessions.map((session) => ({
            id: session.id,
            generation: session.generation,
            archived: session.state === 'archived',
          })),
        }))
      ),
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
    const token = ++attachment
    const request = lifecycle.current()
    setConversation(undefined)
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
        state.model.switchTo(next.runtimeSessionId)
        setConversation(next)
      })
      .catch(() => {
        if (token !== attachment || !lifecycle.isCurrent(request) || ready() !== state) return
        setAttachmentError('This conversation is unavailable. Retry or select another session.')
      })
  })

  // Only a mounted canonical Chat conversation is reported. Conventional
  // workspace/team chat remains a separate domain and never fabricates a
  // runtime session selection.
  bindDesktopChatPresentation('chat', () => conversation()?.runtimeSessionId)

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
    const request = lifecycle.begin()
    void load(request).then((next) => {
      if (lifecycle.isCurrent(request) && next) setReady(next)
    })
    onCleanup(lifecycle.invalidate)
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
        projection.groups.some((group) =>
          group.projects.some((project) =>
            project.sessions.some((session) => session.state !== 'archived')
          )
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
              <DevSidebarNavigation
                groups={state().projection.groups}
                selectedProject={selectedProject() ?? ''}
                selectedSession={selectedSession() ?? ''}
                collapsedGroups={new Set(collapsedGroups())}
                collapsedProjects={new Set(collapsedProjects())}
                compactOpen={sidebarOpen()}
                navigationLabel="Chat projects"
                onProjectSelect={(id) => workspaceStore.getState().setSelectedDevProjectId(id)}
                onSessionSelect={(projectId, sessionId) => {
                  const store = workspaceStore.getState()
                  if (store.selectedDevProjectId !== projectId)
                    store.setSelectedDevProjectId(projectId)
                  store.setSelectedRuntimeSessionId(sessionId)
                }}
                onToggleGroup={(id) => workspaceStore.getState().toggleDevGroupCollapsed(id)}
                onToggleProject={(id) => workspaceStore.getState().toggleDevProjectCollapsed(id)}
              />
              <div class="workspace-runtime-chat">
                <Show
                  when={conversation()}
                  fallback={
                    <Show
                      when={state().kind === 'first-run'}
                      fallback={
                        <div role="status">
                          <p>
                            {attachmentError() ||
                              (selection()?.status === 'empty' || !conversationSelectionId()
                                ? 'Select a project with a conversation.'
                                : 'Opening conversation…')}
                          </p>
                          <Show when={attachmentError()}>
                            <Button onClick={() => setRetry((value) => value + 1)}>
                              Retry conversation
                            </Button>
                          </Show>
                        </div>
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
                      readingPosition={props.modelHost.readingPosition(state().scope, active())}
                      onReadingPositionChange={(identity, position) => {
                        if (!lifecycle.isCurrent(request)) return
                        props.modelHost.setReadingPosition(state().scope, identity, position)
                      }}
                      draftRevision={props.modelHost.draftRevision(
                        state().scope,
                        active().runtimeSessionId
                      )}
                      onDraftChange={(draft, identity, expectedRevision) => {
                        if (!lifecycle.isCurrent(request)) return
                        const next = props.modelHost.setDraft(
                          state().scope,
                          identity,
                          draft,
                          expectedRevision
                        )
                        if (next) setConversation(next)
                      }}
                    />
                  )}
                </Show>
              </div>
            </div>
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
