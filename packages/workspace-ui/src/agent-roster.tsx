import type { AgentSummary, ProjectSummary } from '@adea-ai/types'
import { Bot, MessageCircle, Pencil, Plus, X } from 'lucide-solid'
import { createMemo, createSignal, For, Show, type Accessor, type JSX } from 'solid-js'

import { AgentStatus } from './agent-status'
import { agentProfileActionNotice } from './agent-profile-notice'
import { agentProfileStateNotice } from './agent-profile-state'
import { keyedRows } from './keyed-rows'
import { createClientRequestId } from './request-id'
import { WorkspaceEmpty } from './workspace-states'
import { ActionButton } from '@adea-ai/ui/components/composites/action-button'
import { PropertyList, PropertyTerm, PropertyValue } from '@adea-ai/ui/components/composites/stat'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@adea-ai/ui/components/ui/alert-dialog'
import { Avatar, AvatarFallback } from '@adea-ai/ui/components/ui/avatar'
import { Badge } from '@adea-ai/ui/components/ui/badge'
import { Button } from '@adea-ai/ui/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@adea-ai/ui/components/ui/card'
import { Alert, AlertDescription } from '@adea-ai/ui/components/ui/alert'
import { FormField } from '@adea-ai/ui/components/ui/field'
import { Input } from '@adea-ai/ui/components/ui/input'
import { Label } from '@adea-ai/ui/components/ui/label'
import { NativeSelect } from '@adea-ai/ui/components/ui/native-select'
import { Textarea } from '@adea-ai/ui/components/ui/textarea'
import { Heading, Text } from '@adea-ai/ui/components/ui/typography'

/** `requestId` stays the same across retries of one deliberate action, so a lost response cannot fork the topic. */
export type NewConversationRequest = Readonly<{ requestId: string; title: string }>

export type AgentCustomizationInput = Readonly<{
  avatarRef: string | null
  characterRef: string | null
  name: string
  profileId: string
  profileVersion: string
  roleSummary: string | null
  projectId: string | null
}>

type Props = Readonly<{
  /**
   * Supplemental account-wide durable identities, mounted below this
   * workspace's canonical roster in the existing Agents view.
   */
  /** Lead setup status, placed inside the directory's padding under the header. */
  leadStatus?: JSX.Element
  agents: readonly AgentSummary[]
  busy: boolean
  onCreate: (
    input: Readonly<{
      name: string
      profileId: string
      profileVersion: string
      roleSummary?: string
    }>
  ) => Promise<void>
  onArchive: (agentId: string) => Promise<void>
  onMessage: (agentId: string) => Promise<void>
  /** Start a distinct topic with this Agent; the server commits one conversation per call. */
  onNewConversation: (agentId: string, topic: NewConversationRequest) => Promise<void>
  onUpdate: (agent: AgentSummary, input: AgentCustomizationInput) => Promise<void>
  projects: readonly ProjectSummary[]
}>

function AgentRosterCard(props: {
  agent: Accessor<AgentSummary>
  projectById: Accessor<ReadonlyMap<string, ProjectSummary>>
  onMessage: (agent: AgentSummary) => void
  onNewConversation: (agent: AgentSummary, topic: NewConversationRequest) => Promise<void>
  onCustomize: (agent: AgentSummary) => void
}) {
  const agent = () => props.agent()
  const [naming, setNaming] = createSignal(false)
  const [starting, setStarting] = createSignal(false)
  const [startError, setStartError] = createSignal<string | null>(null)
  let pendingRequestId: string | undefined
  return (
    <article>
      <Card>
        <CardHeader>
          <Avatar size="lg" aria-hidden="true">
            <AvatarFallback name={agent().name} />
          </Avatar>
          <CardTitle role="heading" aria-level="2">
            {agent().name}
          </CardTitle>
          <Show when={agent().isWorkspaceLead === true}>
            <Badge variant="subtle" title="Workspace lead">
              Lead
            </Badge>
          </Show>
          <AgentStatus agent={agent()} compact />
        </CardHeader>
        <CardContent>
          <div class="grid gap-3">
            <p>{agent().roleSummary ?? 'No role summary yet.'}</p>
            <PropertyList>
              <PropertyTerm>Profile</PropertyTerm>
              <PropertyValue>
                {agent().profile.id} · {agent().profile.version}
              </PropertyValue>
              <PropertyTerm>Project</PropertyTerm>
              <PropertyValue>
                {agent().projectId
                  ? (props.projectById().get(agent().projectId!)?.name ?? 'Unavailable Project')
                  : 'Unassigned'}
              </PropertyValue>
              <PropertyTerm>Profile state</PropertyTerm>
              <PropertyValue>{agent().profile.state}</PropertyValue>
            </PropertyList>
            <Show when={agent().profile.state !== 'available'}>
              <p>{agentProfileStateNotice(agent().profile)}</p>
            </Show>
          </div>
        </CardContent>
        <CardFooter>
          <div class="flex w-full flex-col items-stretch gap-2">
            <Button type="button" variant="outline" onClick={() => props.onMessage(agent())}>
              <MessageCircle aria-hidden="true" />
              Open conversation
            </Button>
            <Show
              when={naming()}
              fallback={
                <Button type="button" variant="outline" onClick={() => setNaming(true)}>
                  <Plus aria-hidden="true" />
                  New conversation
                </Button>
              }
            >
              <form
                class="grid gap-2"
                onSubmit={async (event) => {
                  event.preventDefault()
                  const title = String(new FormData(event.currentTarget).get('topic') ?? '').trim()
                  if (!title || starting()) return
                  setStarting(true)
                  setStartError(null)
                  try {
                    pendingRequestId ??= createClientRequestId()
                    await props.onNewConversation(agent(), { requestId: pendingRequestId, title })
                    pendingRequestId = undefined
                    setNaming(false)
                  } catch {
                    setStartError('The conversation could not be started. Try again.')
                  } finally {
                    setStarting(false)
                  }
                }}
              >
                <Label for={`new-topic-${agent().id}`}>Topic for {agent().name}</Label>
                <Input
                  id={`new-topic-${agent().id}`}
                  name="topic"
                  maxLength={120}
                  required
                  autofocus
                  placeholder="What is this conversation about?"
                />
                <Show when={startError()}>{(message) => <p role="alert">{message()}</p>}</Show>
                <div class="flex gap-2">
                  <Button type="submit" disabled={starting()}>
                    {starting() ? 'Starting…' : 'Start conversation'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={starting()}
                    onClick={() => {
                      setNaming(false)
                      setStartError(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </Show>
            <Button type="button" variant="outline" onClick={() => props.onCustomize(agent())}>
              <Pencil aria-hidden="true" />
              Customize
            </Button>
          </div>
        </CardFooter>
      </Card>
    </article>
  )
}

export function AgentRoster(props: Props) {
  const [creating, setCreating] = createSignal(false)
  // Keep the opening revision through refetches; a concurrent edit must conflict.
  const [editingAgent, setEditingAgent] = createSignal<AgentSummary | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const projectById = createMemo(
    () => new Map(props.projects.map((project) => [project.id, project]))
  )
  // Keyed by agent id: an agents refetch updates cards in place instead of
  // remounting the grid on every new object identity.
  const agentRows = keyedRows(
    () => props.agents,
    (agent) => agent.id,
    (previous, next) => previous.updatedAt === next.updatedAt
  )
  const renderAgent = (agent: Accessor<AgentSummary>) => (
    <AgentRosterCard
      agent={agent}
      projectById={projectById}
      onMessage={(current) => void props.onMessage(current.id)}
      onNewConversation={(current, topic) => props.onNewConversation(current.id, topic)}
      onCustomize={setEditingAgent}
    />
  )
  return (
    <section class="conventional-directory" aria-labelledby="agent-roster-title">
      <header class="conventional-surface-header">
        <div>
          <span>Durable identities</span>
          <Heading as="h1" size="title" id="agent-roster-title">
            Agents
          </Heading>
          <p>Status reflects configuration only. Runtime availability arrives later.</p>
        </div>
        <Button type="button" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          New Agent
          <Bot aria-hidden="true" />
        </Button>
      </header>
      <Show when={props.leadStatus}>
        {(status) => <div class="conventional-surface-status">{status()}</div>}
      </Show>
      <Show when={creating()}>
        <AgentCreateForm
          busy={props.busy}
          error={error()}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            setError(null)
            try {
              await props.onCreate(input)
              setCreating(false)
            } catch (cause) {
              setError(agentProfileActionNotice(cause))
            }
          }}
        />
      </Show>
      <Show when={editingAgent()} keyed>
        {(agent) => (
          <AgentCustomizationForm
            agent={agent}
            busy={props.busy}
            error={error()}
            onArchive={async (target) => {
              setError(null)
              try {
                await props.onArchive(target.id)
                setEditingAgent(null)
              } catch {
                setError('Agent could not be archived. Resolve linked constraints and retry.')
              }
            }}
            onCancel={() => setEditingAgent(null)}
            onSubmit={async (target, input) => {
              setError(null)
              try {
                await props.onUpdate(target, input)
                setEditingAgent(null)
              } catch (cause) {
                setError(agentProfileActionNotice(cause))
              }
            }}
            projects={props.projects}
          />
        )}
      </Show>
      <div class="conventional-agent-grid">
        <For each={agentRows()}>{(entry) => renderAgent(entry.item)}</For>
      </div>
      <Show when={!props.agents.length}>
        <WorkspaceEmpty
          title="No Agents yet"
          detail="Create a durable Agent identity, then start a direct conversation."
        />
      </Show>
    </section>
  )
}

function AgentCustomizationForm(props: {
  agent: AgentSummary
  busy: boolean
  error: string | null
  onArchive: (agent: AgentSummary) => Promise<void>
  onCancel: () => void
  onSubmit: (agent: AgentSummary, input: AgentCustomizationInput) => Promise<void>
  projects: readonly ProjectSummary[]
}) {
  return (
    <form
      class="conventional-agent-form conventional-agent-customization"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void props.onSubmit(props.agent, {
          avatarRef: String(form.get('avatarRef') ?? '').trim() || null,
          characterRef: String(form.get('characterRef') ?? '').trim() || null,
          name: String(form.get('name') ?? ''),
          profileId: String(form.get('profileId') ?? ''),
          profileVersion: String(form.get('profileVersion') ?? ''),
          roleSummary: String(form.get('roleSummary') ?? '').trim() || null,
          projectId: String(form.get('projectId') ?? '').trim() || null,
        })
      }}
    >
      <Card>
        <CardHeader>
          <div class="flex items-start justify-between gap-2">
            <div>
              <Heading as="h2" size="card">
                Customize {props.agent.name}
              </Heading>
              <Text as="p" variant="caption" tone="muted">
                Stable identity · {props.agent.id}
              </Text>
            </div>
            <ActionButton
              type="button"
              aria-label="Close Agent customization"
              tooltip="Close Agent customization"
              variant="ghost"
              size="icon-sm"
              onClick={() => props.onCancel()}
            >
              <X aria-hidden="true" />
            </ActionButton>
          </div>
        </CardHeader>
        <CardContent>
          <div class="flex flex-col gap-4">
            <AgentStatus agent={props.agent} />
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <FormField label="Name">
                <Input name="name" required maxLength={120} value={props.agent.name} />
              </FormField>
              <FormField label="Project">
                <NativeSelect
                  class="w-full"
                  name="projectId"
                  value={props.agent.projectId ?? ''}
                  options={[
                    { value: '', label: 'Unassigned' },
                    ...props.projects.map((project) => ({
                      value: project.id,
                      label: project.name,
                    })),
                  ]}
                />
              </FormField>
              <FormField class="col-span-full" label="Role or persona">
                <Textarea
                  name="roleSummary"
                  rows={3}
                  maxLength={500}
                  value={props.agent.roleSummary ?? ''}
                />
              </FormField>
              <FormField label="Avatar reference">
                <Input
                  name="avatarRef"
                  maxLength={500}
                  value={props.agent.avatarRef ?? ''}
                  placeholder="Optional stable asset reference"
                />
              </FormField>
              <FormField label="Character reference">
                <Input
                  name="characterRef"
                  maxLength={500}
                  value={props.agent.characterRef ?? ''}
                  placeholder="Optional character reference"
                />
              </FormField>
              <AgentProfileFields profile={props.agent.profile} />
            </div>
            <Show when={props.error}>
              {(error) => (
                <Alert variant="destructive">
                  <AlertDescription>{error()}</AlertDescription>
                </Alert>
              )}
            </Show>
            <div class="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={props.busy}>
                {props.busy ? 'Saving…' : 'Save changes'}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger
                  as={Button}
                  type="button"
                  variant="outline"
                  disabled={props.busy}
                >
                  Archive Agent
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{`Archive ${props.agent.name}`}</AlertDialogTitle>
                    <AlertDialogDescription>
                      Archive this Agent? Durable conversations and history remain linked to its
                      stable identity.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel as={Button} type="button" variant="outline">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      as={Button}
                      type="button"
                      variant="destructive"
                      disabled={props.busy}
                      onClick={() => void props.onArchive(props.agent)}
                    >
                      Confirm archive
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            <Text as="p" variant="caption" tone="muted">
              Permanent deletion is unavailable because it would break durable identity and
              conversation references.
            </Text>
          </div>
        </CardContent>
      </Card>
    </form>
  )
}

function AgentCreateForm(props: {
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: Props['onCreate']
}) {
  return (
    <form
      class="conventional-agent-form"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void props.onSubmit({
          name: String(form.get('name') ?? ''),
          profileId: String(form.get('profileId') ?? ''),
          profileVersion: String(form.get('profileVersion') ?? ''),
          roleSummary: String(form.get('roleSummary') ?? ''),
        })
      }}
    >
      <Card>
        <CardHeader>
          <div class="flex items-start justify-between gap-2">
            <Heading as="h2" size="card">
              Create Agent
            </Heading>
            <ActionButton
              type="button"
              aria-label="Cancel Agent creation"
              tooltip="Cancel Agent creation"
              variant="ghost"
              size="icon-sm"
              onClick={() => props.onCancel()}
            >
              <X aria-hidden="true" />
            </ActionButton>
          </div>
        </CardHeader>
        <CardContent>
          <div class="flex flex-col gap-4">
            <FormField label="Name">
              <Input name="name" required maxLength={120} />
            </FormField>
            <FormField label="Role or persona">
              <Textarea name="roleSummary" rows={2} maxLength={500} />
            </FormField>
            <AgentProfileFields />
            <Show when={props.error}>
              {(error) => (
                <Alert variant="destructive">
                  <AlertDescription>{error()}</AlertDescription>
                </Alert>
              )}
            </Show>
            <Button type="submit" disabled={props.busy}>
              {props.busy ? 'Creating…' : 'Create Agent'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  )
}

function AgentProfileFields(props: { profile?: AgentSummary['profile'] }) {
  const id = props.profile?.id ?? ''
  const version = props.profile?.version ?? ''
  return (
    <>
      <FormField label="Profile ID">
        <Input name="profileId" required placeholder="prf_…" maxLength={30} value={id} />
      </FormField>
      <FormField label="Profile version ID">
        <Input name="profileVersion" required placeholder="pfv_…" maxLength={30} value={version} />
      </FormField>
      <Text as="p" variant="caption" tone="muted" class="col-span-full">
        Published, approved IDs: Workspace settings › Skills. Future submissions.
      </Text>
    </>
  )
}
