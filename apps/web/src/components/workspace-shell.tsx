"use client";

import {
  Activity,
  Bot,
  ChevronRight,
  CircleDot,
  Focus,
  Map,
  PanelRight,
  Sparkles,
} from "lucide-react";

import { Button } from "@agent-hq/ui";

import { SceneViewport } from "./scene-viewport";
import { useAgentsQuery } from "@/features/agents/use-agents-query";
import { useWorkspaceStore } from "@/state/workspace-store";

export function WorkspaceShell() {
  const { data: agents, error, isLoading } = useAgentsQuery();
  const selectedAgentId = useWorkspaceStore((state) => state.selectedAgentId);
  const isDetailsPanelOpen = useWorkspaceStore((state) => state.isDetailsPanelOpen);
  const viewMode = useWorkspaceStore((state) => state.viewMode);
  const selectAgent = useWorkspaceStore((state) => state.selectAgent);
  const setViewMode = useWorkspaceStore((state) => state.setViewMode);
  const toggleDetailsPanel = useWorkspaceStore((state) => state.toggleDetailsPanel);

  const selectedAgent = agents?.find((agent) => agent.id === selectedAgentId) ?? agents?.[0];

  return (
    <main className="workspace-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={16} strokeWidth={1.8} />
          </div>
          <div>
            <p className="eyebrow">AGENT OPERATIONS</p>
            <h1>Agent HQ</h1>
          </div>
        </div>
        <div className="topbar__status" role="status">
          <span className="status-dot status-dot--active" aria-hidden="true" />
          <span>Workspace online</span>
          <span className="topbar__divider" aria-hidden="true" />
          <span className="muted">3 agents connected</span>
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
                    onClick={() => selectAgent(agent.id)}
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
              <p className="eyebrow">ROOM 01 / COMMAND FLOOR</p>
              <h2 id="scene-title">The observatory</h2>
            </div>
            <div className="view-switcher" aria-label="Scene view">
              <Button
                aria-pressed={viewMode === "map"}
                onClick={() => setViewMode("map")}
                size="sm"
                variant={viewMode === "map" ? "default" : "ghost"}
              >
                <Map size={14} aria-hidden="true" />
                Map
              </Button>
              <Button
                aria-pressed={viewMode === "focus"}
                onClick={() => setViewMode("focus")}
                size="sm"
                variant={viewMode === "focus" ? "default" : "ghost"}
              >
                <Focus size={14} aria-hidden="true" />
                Focus
              </Button>
            </div>
          </div>
          <SceneViewport />
          <div className="scene-panel__footer">
            <span>
              <span className="legend-swatch legend-swatch--active" />
              Active task
            </span>
            <span>
              <span className="legend-swatch legend-swatch--waiting" />
              Awaiting input
            </span>
            <span className="muted">Drag to orbit · Scroll to zoom</span>
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
                  <p className="detail-section__title">Scene coordination is client-only.</p>
                  <p className="detail-section__meta">
                    Durable agent data remains server state through TanStack Query.
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
