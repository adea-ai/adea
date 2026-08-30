import { useState } from 'react'
import type { AgentSummary, RoomSummary } from '@agent-hq/types'
import { Bot, MessageCircle, Plus, X } from 'lucide-react'

import { WorkspaceEmpty } from './workspace-states'

function lifecycleCopy(agent: AgentSummary) {
  if (agent.lifecycleState === 'configuration_error') return 'Configuration issue'
  if (agent.lifecycleState === 'archived') return 'Archived'
  if (agent.profile.state !== 'available') return 'Profile unavailable'
  return 'Configured'
}

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
  onMessage: (agentId: string) => Promise<void>
  rooms: readonly RoomSummary[]
}>

export function AgentRoster({ agents, busy, onCreate, onMessage, rooms }: Props) {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const roomById = new Map(rooms.map((room) => [room.id, room]))
  return (
    <section className="conventional-directory" aria-labelledby="agent-roster-title">
      <header className="conventional-surface-header">
        <div>
          <span>Durable identities</span>
          <h1 id="agent-roster-title">Agents</h1>
          <p>Status reflects configuration only. Runtime availability arrives later.</p>
        </div>
        <button
          type="button"
          className="conventional-primary-button"
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" />
          New Agent
        </button>
      </header>
      {creating ? (
        <AgentCreateForm
          busy={busy}
          error={error}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            setError(null)
            try {
              await onCreate(input)
              setCreating(false)
            } catch {
              setError('Agent could not be created. Check the fields and retry.')
            }
          }}
        />
      ) : null}
      <div className="conventional-agent-grid">
        {agents.map((agent) => (
          <article key={agent.id} className="conventional-agent-card">
            <div className="conventional-agent-card__avatar" aria-hidden="true">
              <Bot />
            </div>
            <div className="conventional-agent-card__identity">
              <h2>{agent.name}</h2>
              <span
                className={`conventional-lifecycle conventional-lifecycle--${agent.lifecycleState}`}
              >
                {lifecycleCopy(agent)}
              </span>
            </div>
            <p>{agent.roleSummary ?? 'No role summary yet.'}</p>
            <div className="conventional-agent-card__metadata">
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
                    ? (roomById.get(agent.roomId)?.name ?? 'Unavailable Room')
                    : 'Unassigned'}
                </strong>
              </p>
              <p>
                <span>Profile state</span>
                <strong>{agent.profile.state}</strong>
              </p>
            </div>
            <button type="button" onClick={() => void onMessage(agent.id)}>
              <MessageCircle aria-hidden="true" />
              Open conversation
            </button>
          </article>
        ))}
      </div>
      {!agents.length ? (
        <WorkspaceEmpty
          title="No Agents yet"
          detail="Create a durable Agent identity, then start a direct conversation."
        />
      ) : null}
    </section>
  )
}

function AgentCreateForm({
  busy,
  error,
  onCancel,
  onSubmit,
}: Readonly<{
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: Props['onCreate']
}>) {
  return (
    <form
      className="conventional-inline-form"
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        void onSubmit({
          name: String(form.get('name') ?? ''),
          profileId: String(form.get('profileId') ?? ''),
          profileVersion: String(form.get('profileVersion') ?? ''),
          roleSummary: String(form.get('roleSummary') ?? ''),
        })
      }}
    >
      <div className="conventional-inline-form__header">
        <h2>Create Agent</h2>
        <button type="button" aria-label="Cancel Agent creation" onClick={onCancel}>
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
        <input name="profileId" required defaultValue="general" maxLength={120} />
      </label>
      <label>
        Profile version
        <input name="profileVersion" required defaultValue="1" maxLength={64} />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" className="conventional-primary-button" disabled={busy}>
        {busy ? 'Creating…' : 'Create Agent'}
      </button>
    </form>
  )
}
