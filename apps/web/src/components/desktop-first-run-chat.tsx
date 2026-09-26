import { ChatView, createFirstRunRuntimePort, FirstRunOnboarding } from '@adea-ai/dev-view/chat'
import type { ChatConversation, ChatConversationModel, FirstRunFacts } from '@adea-ai/dev-view/chat'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import { buildDevCommand } from '@adea-ai/dev-view/browser'
import type { Scope } from '@adea-ai/types/dev-runtime'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { createEffect, createSignal, onCleanup, Show, type JSX } from 'solid-js'

import {
  createDesktopChatLifecycleFence,
  type DesktopChatModelHost,
} from '../lib/desktop-chat-host'
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
  facts: FirstRunFacts
  model: ChatConversationModel
  port: ReturnType<typeof createFirstRunRuntimePort>
  scope: Scope
}>

/**
 * Desktop-only Chat entry. It mounts onboarding after the authenticated
 * runtime projection, worktree registry, and workspace AgentProfile list all
 * resolve. Missing authority leaves the existing Chat surface in place.
 */
export function DesktopFirstRunChat(props: DesktopFirstRunChatProps): JSX.Element {
  const [ready, setReady] = createSignal<ReadyState>()
  const [conversation, setConversation] = createSignal<ChatConversation>()
  const lifecycle = createDesktopChatLifecycleFence()

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
    void load().then((next) => {
      if (lifecycle.isCurrent(request) && next) setReady(next)
    })
    onCleanup(lifecycle.invalidate)
  })

  async function load(): Promise<ReadyState | undefined> {
    await props.runtime.ready?.catch(() => undefined)
    const scope = props.runtime.preferenceScope?.()
    if (!scope || props.runtime.state().status !== 'ready') return undefined
    try {
      const model = props.modelHost.get(scope)
      const port = createFirstRunRuntimePort(props.runtime, scope, model)
      const [projection, worktreePage, workspace, managedPi] = await Promise.all([
        props.runtime.projection?.(scope),
        readWorktrees(props.runtime, scope),
        props.client.getWorkspace(props.workspaceId),
        port.readManagedPi(),
      ])
      if (!projection || !workspace) return undefined
      const resolution = resolveDesktopFirstRun({
        temporary: props.temporary,
        managedPi,
        projection,
        worktrees: worktreePage.items,
        agents: workspace.agents,
      })
      // Existing runtime sessions are already a usable Chat/Dev surface. The
      // first-run entry only takes over an empty canonical runtime projection.
      if (
        projection.groups.some((group) => group.projects.some((project) => project.sessions.length))
      )
        return undefined
      const boundPort = createFirstRunRuntimePort(props.runtime, scope, model, resolution.context)
      return {
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
      {(state) => (
        <Show
          when={conversation()}
          fallback={
            <FirstRunOnboarding
              facts={state().facts}
              port={state().port}
              onAction={async (kind) => {
                if (kind === 'sign_in') return props.onSignIn()
                if (kind === 'add_project' || kind === 'set_up_agent') props.onOpenDev()
                if (kind === 'retry_access' || kind === 'update_app') {
                  const request = lifecycle.begin()
                  setReady(undefined)
                  setConversation(undefined)
                  const next = await load()
                  if (lifecycle.isCurrent(request) && next) setReady(next)
                }
              }}
              onConversation={(created) => {
                const request = lifecycle.current()
                const model = state().model
                void model.attach(created.runtimeSessionId).then((next) => {
                  if (!lifecycle.isCurrent(request) || ready()?.model !== model) return
                  setConversation(next)
                })
              }}
            />
          }
        >
          {(active) => {
            const request = lifecycle.current()
            return (
              <ChatView
                conversation={active()}
                model={state().model}
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
            )
          }}
        </Show>
      )}
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
