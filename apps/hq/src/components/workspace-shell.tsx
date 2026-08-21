"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import {
  Activity,
  Bot,
  ChevronRight,
  CircleDot,
  Focus,
  LayoutGrid,
  Map,
  PanelRight,
  Sparkles,
  Users,
} from "lucide-react";
import {
  ithappyCharacterIds,
  ithappyCustomCharacterIds,
  getCustomCharacterLabel,
} from "@agent-hq/ithappy/catalog";
import { Button } from "@agent-hq/ui";
import { RoomDesignerPanel } from "./room-designer-panel";
import { useAgentsQuery } from "@/features/agents/use-agents-query";
import { hqSceneLabel, type HqSceneId } from "@/features/hq/hq-scene";
import { useHqLayoutQuery } from "@/features/hq/use-hq-layout-query";
import { useWorkspaceStore } from "@/state/workspace-store";
import { useWorkspaceUrlState } from "@/state/use-workspace-url-state";
import type { RoomLayoutDocument } from "@agent-hq/rooms";

const SceneViewport = dynamic(
  () => import("./scene-viewport").then((module) => module.SceneViewport),
  {
    loading: () => <div className="scene-viewport__loading">Preparing the HQ workspace…</div>,
    ssr: false,
  },
);

const characters = [
  ...ithappyCharacterIds.map((id) => ({
    id,
    label: id.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
  })),
  ...ithappyCustomCharacterIds.map((id) => ({ id, label: getCustomCharacterLabel(id) ?? id })),
];

export function WorkspaceShell() {
  const { data: agents, error, isLoading } = useAgentsQuery();
  const { cameraMode, sceneId, selectedAgentId, setCameraMode, setSceneId, setSelectedAgentId } =
    useWorkspaceUrlState();
  const characterId = useWorkspaceStore((state) => state.characterId);
  const isDetailsPanelOpen = useWorkspaceStore((state) => state.isDetailsPanelOpen);
  const roomDesignerOpen = useWorkspaceStore((state) => state.roomDesignerOpen);
  const setCharacterId = useWorkspaceStore((state) => state.setCharacterId);
  const toggleDetailsPanel = useWorkspaceStore((state) => state.toggleDetailsPanel);
  const setRoomDesignerOpen = useWorkspaceStore((state) => state.setRoomDesignerOpen);
  const layoutQuery = useHqLayoutQuery(sceneId);
  const [draftLayouts, setDraftLayouts] = useState<Partial<Record<HqSceneId, RoomLayoutDocument>>>(
    {},
  );
  const draftLayout = draftLayouts[sceneId];
  const layout = draftLayout ?? layoutQuery.data;
  const setDraftLayout = (nextLayout: RoomLayoutDocument | undefined) => {
    setDraftLayouts((current) => ({ ...current, [sceneId]: nextLayout }));
  };

  const selectedAgent = agents?.find((agent) => agent.id === selectedAgentId) ?? agents?.[0];
  return (
    <main className="workspace-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={16} strokeWidth={1.8} />
          </div>
          <div>
            <p className="eyebrow">SPATIAL AGENT OPERATIONS</p>
            <h1>Agent HQ</h1>
          </div>
        </div>
        <div className="topbar__status" role="status">
          <span className="status-dot status-dot--active" aria-hidden="true" />
          <span>{layoutQuery.isLoading ? "Loading workspace" : "Workspace online"}</span>
          <span className="topbar__divider" aria-hidden="true" />
          <span className="muted">
            {agents?.length ?? 0} agents · {hqSceneLabel(sceneId)}
          </span>
        </div>
        <Button variant="secondary" size="sm">
          <CircleDot size={15} aria-hidden="true" />
          Command bar
        </Button>
      </header>

      <div className="workspace-grid">
        <aside className="agent-rail" aria-labelledby="agent-rail-title">
          <div className="rail-heading">
            <div>
              <p className="eyebrow">ROSTER</p>
              <h2 id="agent-rail-title">Your agents</h2>
            </div>
            <span className="count-badge">{agents?.length ?? 0}</span>
          </div>
          {isLoading && <p className="rail-message">Loading roster…</p>}
          {error && <p className="rail-message rail-message--error">Roster unavailable.</p>}
          {!isLoading && !error && (
            <div className="agent-list" role="list">
              {(agents ?? []).map((agent) => {
                const isSelected = agent.id === (selectedAgentId ?? agents?.[0]?.id);
                return (
                  <button
                    key={agent.id}
                    aria-current={isSelected ? "true" : undefined}
                    className={`agent-card${isSelected ? " agent-card--selected" : ""}`}
                    onClick={() => void setSelectedAgentId(agent.id)}
                    role="listitem"
                    type="button"
                  >
                    <span
                      className="agent-avatar"
                      style={{ "--agent-color": agent.color } as React.CSSProperties}
                    >
                      <Bot size={17} aria-hidden="true" />
                    </span>
                    <span className="agent-card__copy">
                      <span className="agent-card__name">
                        {agent.name}
                        <span
                          className={`status-dot status-dot--${agent.status}`}
                          aria-label={agent.status}
                        />
                      </span>
                      <span className="agent-card__role">{agent.role}</span>
                    </span>
                    <ChevronRight className="agent-card__arrow" size={15} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          )}
          <div className="rail-footer">
            <div className="rail-footer__icon" aria-hidden="true">
              <Activity size={15} />
            </div>
            <div>
              <p className="eyebrow">SYSTEM PULSE</p>
              <p className="rail-footer__value">Nominal</p>
            </div>
          </div>
        </aside>

        <section className="scene-panel" aria-labelledby="scene-title">
          <div className="scene-panel__header">
            <div>
              <p className="eyebrow">HQ / {sceneId === "hq-home" ? "HOME" : "WORK"}</p>
              <h2 id="scene-title">
                {sceneId === "hq-home" ? "The residence" : "The operations floor"}
              </h2>
            </div>
            <div className="view-switcher" aria-label="Scene controls">
              <Button
                aria-pressed={sceneId === "hq-home"}
                onClick={() => {
                  void setSceneId("hq-home");
                  setRoomDesignerOpen(false);
                }}
                size="sm"
                variant={sceneId === "hq-home" ? "default" : "ghost"}
              >
                <Map size={14} aria-hidden="true" />
                Home
              </Button>
              <Button
                aria-pressed={sceneId === "hq-work"}
                onClick={() => {
                  void setSceneId("hq-work");
                  setRoomDesignerOpen(false);
                }}
                size="sm"
                variant={sceneId === "hq-work" ? "default" : "ghost"}
              >
                <Users size={14} aria-hidden="true" />
                Work
              </Button>
              <Button
                aria-pressed={cameraMode === "orthographic"}
                onClick={() => setCameraMode("orthographic")}
                size="sm"
                variant={cameraMode === "orthographic" ? "default" : "ghost"}
              >
                <LayoutGrid size={14} aria-hidden="true" />
                Plan
              </Button>
              <Button
                aria-pressed={cameraMode === "perspective"}
                onClick={() => setCameraMode("perspective")}
                size="sm"
                variant={cameraMode === "perspective" ? "default" : "ghost"}
              >
                <Focus size={14} aria-hidden="true" />
                Focus
              </Button>
            </div>
          </div>
          <div className="scene-toolbar">
            <label>
              Avatar
              <select value={characterId} onChange={(event) => setCharacterId(event.target.value)}>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              aria-pressed={roomDesignerOpen}
              onClick={() => setRoomDesignerOpen(!roomDesignerOpen)}
              size="sm"
              variant={roomDesignerOpen ? "default" : "secondary"}
            >
              <LayoutGrid size={14} aria-hidden="true" />
              {roomDesignerOpen ? "Close designer" : "Room designer"}
            </Button>
          </div>
          <div className="scene-stage">
            {layout ? (
              <SceneViewport
                key={sceneId}
                sceneId={sceneId}
                characterId={characterId}
                cameraMode={cameraMode}
                layout={layout}
                designerOpen={roomDesignerOpen}
              />
            ) : (
              <div className="scene-viewport__loading">Preparing the HQ workspace…</div>
            )}
            {roomDesignerOpen && layout ? (
              <RoomDesignerPanel
                layout={layout}
                sceneName={hqSceneLabel(sceneId)}
                onChange={setDraftLayout}
                onSave={async () => {
                  await layoutQuery.saveLayout(layout);
                  setRoomDesignerOpen(false);
                }}
                onReset={() => setDraftLayout(layoutQuery.data)}
                onClose={() => setRoomDesignerOpen(false)}
                isSaving={layoutQuery.isSaving}
              />
            ) : null}
          </div>
          <div className="scene-panel__footer">
            <span>
              <span className="legend-swatch legend-swatch--active" />
              Active task
            </span>
            <span>
              <span className="legend-swatch legend-swatch--waiting" />
              Awaiting input
            </span>
            <span className="muted">Drag to orbit · Scroll to zoom · Click to move</span>
          </div>
        </section>

        {isDetailsPanelOpen && (
          <aside className="details-panel" aria-labelledby="details-title">
            <div className="details-panel__header">
              <div>
                <p className="eyebrow">SELECTED UNIT</p>
                <h2 id="details-title">Agent detail</h2>
              </div>
              <Button
                aria-label="Close agent detail panel"
                onClick={toggleDetailsPanel}
                size="icon"
                variant="ghost"
              >
                <PanelRight size={17} aria-hidden="true" />
              </Button>
            </div>
            {selectedAgent ? (
              <div className="details-content">
                <div className="details-identity">
                  <span
                    className="details-identity__avatar"
                    style={{ "--agent-color": selectedAgent.color } as React.CSSProperties}
                  >
                    <Bot size={24} aria-hidden="true" />
                  </span>
                  <div>
                    <h3>{selectedAgent.name}</h3>
                    <p>{selectedAgent.role}</p>
                  </div>
                  <span className={`pill pill--${selectedAgent.status}`}>
                    {selectedAgent.status}
                  </span>
                </div>
                <div className="detail-section">
                  <p className="eyebrow">CURRENT ASSIGNMENT</p>
                  <p className="detail-section__title">{selectedAgent.task}</p>
                  <div className="progress-track" aria-label="Task progress: 68 percent">
                    <span className="progress-track__value" />
                  </div>
                  <p className="detail-section__meta">68% complete · Updated just now</p>
                </div>
                <div className="detail-section detail-section--boundary">
                  <p className="eyebrow">RUNTIME BOUNDARY</p>
                  <p className="detail-section__title">Spatial state stays client-only.</p>
                  <p className="detail-section__meta">
                    Agent data remains server state through TanStack Query; the scene is vanilla
                    Three.js behind its controller boundary.
                  </p>
                </div>
              </div>
            ) : (
              <p className="details-empty">Select an agent to inspect its current assignment.</p>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}
