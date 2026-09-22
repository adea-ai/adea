import {
  ChatView,
  createChatConversationModel,
  createFirstRunRuntimePort,
  FirstRunOnboarding,
} from '@adea-ai/dev-view/chat'
import type { ChatConversation, FirstRunFacts } from '@adea-ai/dev-view/chat'
import type { DevRuntimeService } from '@adea-ai/dev-view/platform'
import { buildDevCommand } from '@adea-ai/dev-view/browser'
import type { Scope } from '@adea-ai/types/dev-runtime'
import type { AgentHqApiClient } from '@adea-ai/api-client'
import { createEffect, createSignal, Show, type JSX } from 'solid-js'

import { resolveDesktopFirstRun, type DesktopFirstRunWorktree } from '../lib/desktop-first-run-chat'

type WorktreePage = Readonly<{ items: readonly DesktopFirstRunWorktree[] }>

export type DesktopFirstRunChatProps = Readonly<{
  client: AgentHqApiClient
  fallback: JSX.Element
  onOpenDev(): void
  onSignIn(): void | Promise<void>
  runtime: DevRuntimeService
  temporary: boolean
  workspaceId: string
}>

type ReadyState = Readonly<{
  facts: FirstRunFacts
  model: ReturnType<typeof createChatConversationModel>
  port: ReturnType<typeof createFirstRunRuntimePort>
}>

/**
 * Desktop-only Chat entry. It mounts onboarding after the authenticated
 * runtime projection, worktree registry, and workspace AgentProfile list all
 * resolve. Missing authority leaves the existing Chat surface in place.
 */
export function DesktopFirstRunChat(props: DesktopFirstRunChatProps): JSX.Element {
  const [ready, setReady] = createSignal<ReadyState>()
  const [conversation, setConversation] = createSignal<ChatConversation>()

  createEffect(() => {
    let disposed = false
    setReady(undefined)
    setConversation(undefined)
    void load().then((next) => {
      if (!disposed && next) setReady(next)
    })
    return () => {
      disposed = true
    }
  })

  async function load(): Promise<ReadyState | undefined> {
    await props.runtime.ready?.catch(() => undefined)
    const scope = props.runtime.preferenceScope?.()
    if (!scope || props.runtime.state().status !== 'ready') return undefined
    try {
      const model = createChatConversationModel(props.runtime, scope)
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
                  const next = await load()
                  if (next) setReady(next)
                }
              }}
              onConversation={(created) => {
                void state().model.attach(created.runtimeSessionId).then(setConversation)
              }}
            />
          }
        >
          {(active) => <ChatView conversation={active()} model={state().model} />}
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
