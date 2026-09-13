import type { AgentSummary, RoomSummary } from '@adea-ai/types'
import { Bot, MessageCircle, Pencil, Plus, ShieldAlert, X } from 'lucide-solid'
import { createMemo, createSignal, For, Show } from 'solid-js'

import { AgentStatus } from './agent-status'
import { WorkspaceEmpty } from './workspace-states'

export type AgentCustomizationInput = Readonly<{
  avatarRef: string | null
  characterRef: string | null
  name: string
  profileId: string
  profileVersion: string
  roleSummary: string | null
  roomId: string | null
}>

type Props = Readonly<{
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
  onUpdate: (agent: AgentSummary, input: AgentCustomizationInput) => Promise<void>
  rooms: readonly RoomSummary[]
}>

export function AgentRoster(props: Props) {
  const [creating, setCreating] = createSignal(false)
  const [editingAgentId, setEditingAgentId] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const roomById = createMemo(() => new Map(props.rooms.map((room) => [room.id, room])))
  const editingAgent = createMemo(() => props.agents.find(({ id }) => id === editingAgentId()))

  return (
    <section class="conventional-directory" aria-labelledby="agent-roster-title">
      <header class="conventional-surface-header">
        <div>
          <span>Durable identities</span>
          <h1 id="agent-roster-title">Agents</h1>
          <p>Status reflects configuration only. Runtime availability arrives later.</p>
        </div>
        <button type="button" class="conventional-primary-button" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          New Agent
          <Bot aria-hidden="true" />
        </button>
      </header>
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
            } catch {
              setError('Agent could not be created. Check the fields and retry.')
            }
          }}
        />
      </Show>
      <Show when={editingAgent()}>
        {(agent) => (
          <AgentCustomizationForm
            agent={agent()}
            busy={props.busy}
            error={error()}
            onArchive={async (target) => {
              setError(null)
              try {
                await props.onArchive(target.id)
                setEditingAgentId(null)
              } catch {
                setError('Agent could not be archived. Resolve linked constraints and retry.')
              }
            }}
            onCancel={() => setEditingAgentId(null)}
            onSubmit={async (target, input) => {
              setError(null)
              try {
                await props.onUpdate(target, input)
                setEditingAgentId(null)
              } catch {
                setError('Agent changes could not be saved. Review the fields and retry.')
              }
            }}
            rooms={props.rooms}
          />
        )}
      </Show>
      <div class="conventional-agent-grid">
        <For each={props.agents}>
          {(agent) => (
            <article class="conventional-agent-card">
              <div class="conventional-agent-card__avatar" aria-hidden="true">
                <Bot />
              </div>
              <div class="conventional-agent-card__identity">
                <h2>{agent.name}</h2>
              </div>
              <div class="conventional-agent-card__status">
                <AgentStatus agent={agent} compact />
              </div>
              <p>{agent.roleSummary ?? 'No role summary yet.'}</p>
              <div class="conventional-agent-card__metadata">
                <p>
                  <span>Profile</span>
                  <strong>
                    {agent.profile.id} · v{agent.profile.version}
                  </strong>
                </p>
                <p>
                  <span>Room</span>
                  <strong>
                    {agent.roomId
                      ? (roomById().get(agent.roomId)?.name ?? 'Unavailable Room')
                      : 'Unassigned'}
                  </strong>
                </p>
                <p>
                  <span>Profile state</span>
                  <strong>{agent.profile.state}</strong>
                </p>
              </div>
              <button type="button" onClick={() => void props.onMessage(agent.id)}>
                <MessageCircle aria-hidden="true" />
                Open conversation
              </button>
              <button type="button" onClick={() => setEditingAgentId(agent.id)}>
                <Pencil aria-hidden="true" />
                Customize
              </button>
            </article>
          )}
        </For>
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
  rooms: readonly RoomSummary[]
}) {
  const [archiveConfirmation, setArchiveConfirmation] = createSignal(false)
  return (
    <form
      class="conventional-inline-form conventional-agent-customization"
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
          roomId: String(form.get('roomId') ?? '').trim() || null,
        })
      }}
    >
      <div class="conventional-inline-form__header">
        <div>
          <h2>Customize {props.agent.name}</h2>
          <p>Stable identity · {props.agent.id}</p>
        </div>
        <button
          type="button"
          aria-label="Close Agent customization"
          onClick={() => props.onCancel()}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <AgentStatus agent={props.agent} />
      <div class="conventional-form-grid">
        <label>
          Name
          <input name="name" required maxLength={120} value={props.agent.name} />
        </label>
        <label>
          Room
          <select name="roomId" value={props.agent.roomId ?? ''}>
            <option value="">Unassigned</option>
            <For each={props.rooms}>{(room) => <option value={room.id}>{room.name}</option>}</For>
          </select>
        </label>
        <label class="conventional-form-grid__wide">
          Role or persona
          <textarea
            name="roleSummary"
            rows={3}
            maxLength={500}
            value={props.agent.roleSummary ?? ''}
          />
        </label>
        <label>
          Avatar reference
          <input
            name="avatarRef"
            maxLength={500}
            value={props.agent.avatarRef ?? ''}
            placeholder="Optional stable asset reference"
          />
        </label>
        <label>
          Character reference
          <input
            name="characterRef"
            maxLength={500}
            value={props.agent.characterRef ?? ''}
            placeholder="Optional M4 character reference"
          />
        </label>
        <label>
          AgentProfile ID
          <input name="profileId" required maxLength={120} value={props.agent.profile.id} />
        </label>
        <label>
          AgentProfile version
          <input
            name="profileVersion"
            required
            maxLength={64}
            value={props.agent.profile.version}
          />
        </label>
      </div>
      <p class="conventional-settings-note">
        Profile changes are explicit and create auditable Adea events. Model, runtime, tool policy,
        and credentials remain Control Plane-owned.
      </p>
      <Show when={props.error}>{(error) => <p role="alert">{error()}</p>}</Show>
      <div class="conventional-agent-customization__actions">
        <button type="submit" class="conventional-primary-button" disabled={props.busy}>
          {props.busy ? 'Saving…' : 'Save changes'}
        </button>
        <Show
          when={archiveConfirmation()}
          fallback={
            <button
              type="button"
              class="conventional-danger-button"
              disabled={props.busy}
              onClick={() => setArchiveConfirmation(true)}
            >
              Archive Agent
            </button>
          }
        >
          <div
            class="conventional-destructive-confirmation"
            role="alertdialog"
            aria-label={`Archive ${props.agent.name}`}
          >
            <ShieldAlert aria-hidden="true" />
            <p>
              Archive this Agent? Durable conversations and history remain linked to its stable
              identity.
            </p>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => void props.onArchive(props.agent)}
            >
              Confirm archive
            </button>
            <button type="button" onClick={() => setArchiveConfirmation(false)}>
              Cancel
            </button>
          </div>
        </Show>
      </div>
      <p class="conventional-agent-delete-note">
        Permanent deletion is unavailable because it would break durable identity and conversation
        references.
      </p>
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
      class="conventional-inline-form"
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
      <div class="conventional-inline-form__header">
        <h2>Create Agent</h2>
        <button type="button" aria-label="Cancel Agent creation" onClick={() => props.onCancel()}>
          <X aria-hidden="true" />
        </button>
      </div>
      <label>
        Name
        <input name="name" required maxLength={120} />
      </label>
      <label>
        Role or persona
        <textarea name="roleSummary" rows={2} maxLength={500} />
      </label>
      <label>
        Profile ID
        <input name="profileId" required value="general" maxLength={120} />
      </label>
      <label>
        Profile version
        <input name="profileVersion" required value="1" maxLength={64} />
      </label>
      <Show when={props.error}>{(error) => <p role="alert">{error()}</p>}</Show>
      <button type="submit" class="conventional-primary-button" disabled={props.busy}>
        {props.busy ? 'Creating…' : 'Create Agent'}
      </button>
    </form>
  )
}
