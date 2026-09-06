import { useState } from "react";
import type { AgentSummary, RoomSummary } from "@adea/types";
import { Bot, MessageCircle, Pencil, Plus, ShieldAlert, X } from "lucide-react";

import { AgentStatus } from "./agent-status";
import { WorkspaceEmpty } from "./workspace-states";

export type AgentCustomizationInput = Readonly<{
  avatarRef: string | null;
  characterRef: string | null;
  name: string;
  profileId: string;
  profileVersion: string;
  roleSummary: string | null;
  roomId: string | null;
}>;

type Props = Readonly<{
  agents: readonly AgentSummary[];
  busy: boolean;
  onCreate: (
    input: Readonly<{
      name: string;
      profileId: string;
      profileVersion: string;
      roleSummary?: string;
    }>
  ) => Promise<void>;
  onArchive: (agentId: string) => Promise<void>;
  onMessage: (agentId: string) => Promise<void>;
  onUpdate: (agent: AgentSummary, input: AgentCustomizationInput) => Promise<void>;
  rooms: readonly RoomSummary[];
}>;

export function AgentRoster({
  agents,
  busy,
  onArchive,
  onCreate,
  onMessage,
  onUpdate,
  rooms,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const editingAgent = agents.find(({ id }) => id === editingAgentId);
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
          <Bot aria-hidden="true" />
        </button>
      </header>
      {creating ? (
        <AgentCreateForm
          busy={busy}
          error={error}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            setError(null);
            try {
              await onCreate(input);
              setCreating(false);
            } catch {
              setError("Agent could not be created. Check the fields and retry.");
            }
          }}
        />
      ) : null}
      {editingAgent ? (
        <AgentCustomizationForm
          agent={editingAgent}
          busy={busy}
          error={error}
          onArchive={async (agent) => {
            setError(null);
            try {
              await onArchive(agent.id);
              setEditingAgentId(null);
            } catch {
              setError("Agent could not be archived. Resolve linked constraints and retry.");
            }
          }}
          onCancel={() => setEditingAgentId(null)}
          onSubmit={async (agent, input) => {
            setError(null);
            try {
              await onUpdate(agent, input);
              setEditingAgentId(null);
            } catch {
              setError("Agent changes could not be saved. Review the fields and retry.");
            }
          }}
          rooms={rooms}
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
            </div>
            <div className="conventional-agent-card__status">
              <AgentStatus agent={agent} compact />
            </div>
            <p>{agent.roleSummary ?? "No role summary yet."}</p>
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
                    ? (roomById.get(agent.roomId)?.name ?? "Unavailable Room")
                    : "Unassigned"}
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
            <button type="button" onClick={() => setEditingAgentId(agent.id)}>
              <Pencil aria-hidden="true" />
              Customize
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
  );
}

function AgentCustomizationForm({
  agent,
  busy,
  error,
  onArchive,
  onCancel,
  onSubmit,
  rooms,
}: Readonly<{
  agent: AgentSummary;
  busy: boolean;
  error: string | null;
  onArchive: (agent: AgentSummary) => Promise<void>;
  onCancel: () => void;
  onSubmit: (agent: AgentSummary, input: AgentCustomizationInput) => Promise<void>;
  rooms: readonly RoomSummary[];
}>) {
  const [archiveConfirmation, setArchiveConfirmation] = useState(false);
  return (
    <form
      className="conventional-inline-form conventional-agent-customization"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void onSubmit(agent, {
          avatarRef: String(form.get("avatarRef") ?? "").trim() || null,
          characterRef: String(form.get("characterRef") ?? "").trim() || null,
          name: String(form.get("name") ?? ""),
          profileId: String(form.get("profileId") ?? ""),
          profileVersion: String(form.get("profileVersion") ?? ""),
          roleSummary: String(form.get("roleSummary") ?? "").trim() || null,
          roomId: String(form.get("roomId") ?? "").trim() || null,
        });
      }}
    >
      <div className="conventional-inline-form__header">
        <div>
          <h2>Customize {agent.name}</h2>
          <p>Stable identity · {agent.id}</p>
        </div>
        <button type="button" aria-label="Close Agent customization" onClick={onCancel}>
          <X aria-hidden="true" />
        </button>
      </div>
      <AgentStatus agent={agent} />
      <div className="conventional-form-grid">
        <label>
          Name
          <input name="name" required maxLength={120} defaultValue={agent.name} />
        </label>
        <label>
          Room
          <select name="roomId" defaultValue={agent.roomId ?? ""}>
            <option value="">Unassigned</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </label>
        <label className="conventional-form-grid__wide">
          Role or persona
          <textarea
            name="roleSummary"
            rows={3}
            maxLength={500}
            defaultValue={agent.roleSummary ?? ""}
          />
        </label>
        <label>
          Avatar reference
          <input
            name="avatarRef"
            maxLength={500}
            defaultValue={agent.avatarRef ?? ""}
            placeholder="Optional stable asset reference"
          />
        </label>
        <label>
          Character reference
          <input
            name="characterRef"
            maxLength={500}
            defaultValue={agent.characterRef ?? ""}
            placeholder="Optional M4 character reference"
          />
        </label>
        <label>
          AgentProfile ID
          <input name="profileId" required maxLength={120} defaultValue={agent.profile.id} />
        </label>
        <label>
          AgentProfile version
          <input
            name="profileVersion"
            required
            maxLength={64}
            defaultValue={agent.profile.version}
          />
        </label>
      </div>
      <p className="conventional-settings-note">
        Profile changes are explicit and create auditable Agent HQ events. Model, runtime, tool
        policy, and credentials remain Control Plane-owned.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="conventional-agent-customization__actions">
        <button type="submit" className="conventional-primary-button" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {!archiveConfirmation ? (
          <button
            type="button"
            className="conventional-danger-button"
            disabled={busy}
            onClick={() => setArchiveConfirmation(true)}
          >
            Archive Agent
          </button>
        ) : (
          <div
            className="conventional-destructive-confirmation"
            role="alertdialog"
            aria-label={`Archive ${agent.name}`}
          >
            <ShieldAlert aria-hidden="true" />
            <p>
              Archive this Agent? Durable conversations and history remain linked to its stable
              identity.
            </p>
            <button type="button" disabled={busy} onClick={() => void onArchive(agent)}>
              Confirm archive
            </button>
            <button type="button" onClick={() => setArchiveConfirmation(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
      <p className="conventional-agent-delete-note">
        Permanent deletion is unavailable because it would break durable identity and conversation
        references.
      </p>
    </form>
  );
}

function AgentCreateForm({
  busy,
  error,
  onCancel,
  onSubmit,
}: Readonly<{
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: Props["onCreate"];
}>) {
  return (
    <form
      className="conventional-inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void onSubmit({
          name: String(form.get("name") ?? ""),
          profileId: String(form.get("profileId") ?? ""),
          profileVersion: String(form.get("profileVersion") ?? ""),
          roleSummary: String(form.get("roleSummary") ?? ""),
        });
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
        {busy ? "Creating…" : "Create Agent"}
      </button>
    </form>
  );
}
