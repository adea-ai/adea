"use client";

import { useEffect, useState } from "react";
import { createApiClient } from "@agent-hq/api-client";
import type { HqSceneId } from "@agent-hq/app-core";
import { MusicToggle } from "@agent-hq/audio";
import { useWorkspaceQuery } from "@agent-hq/data";
import { useWorkspaceStore } from "@agent-hq/state";
import { BriefcaseBusiness, Home, PanelRight, Sparkles } from "lucide-react";
import { hqHomeManifest } from "@agent-hq/scene-hq-home";
import { hqWorkManifest } from "@agent-hq/scene-hq-work";
import type { SceneStartPosition } from "@agent-hq/asset-manifests";
import { Button, Card, ThemeToggle } from "@agent-hq/ui";
import { HqRoomScene } from "./hq-room-scene";

const sceneOptions = [
  {
    id: "home" as const,
    label: "Home",
    eyebrow: "ROOM 01",
    description: "A quiet planning floor for agents and ideas.",
    icon: Home,
    manifest: hqHomeManifest,
  },
  {
    id: "work" as const,
    label: "Work",
    eyebrow: "ROOM 02",
    description: "The active operations floor for focused execution.",
    icon: BriefcaseBusiness,
    manifest: hqWorkManifest,
  },
] as const;

const sceneById = Object.fromEntries(sceneOptions.map((option) => [option.id, option])) as Record<
  HqSceneId,
  (typeof sceneOptions)[number]
>;

type WorkspaceShellProps = {
  initialScene: HqSceneId;
  initialCharacter: string;
  startPosition?: SceneStartPosition;
  cameraViewMode?: "perspective" | "orthographic";
};

export function WorkspaceShell({
  initialScene,
  initialCharacter,
  startPosition,
  cameraViewMode: initialCameraViewMode = "orthographic",
}: WorkspaceShellProps) {
  const selectedScene = useWorkspaceStore((state) => state.selectedScene);
  const setSelectedScene = useWorkspaceStore((state) => state.setSelectedScene);
  const cameraViewMode = useWorkspaceStore((state) => state.cameraViewMode);
  const setCameraViewMode = useWorkspaceStore((state) => state.setCameraViewMode);
  const isDetailsPanelOpen = useWorkspaceStore((state) => state.detailsPanelOpen);
  const setDetailsPanelOpen = useWorkspaceStore((state) => state.setDetailsPanelOpen);
  const [storeReady, setStoreReady] = useState(false);
  const [apiClient] = useState(() => createApiClient());
  const workspaceQuery = useWorkspaceQuery(apiClient, "default");
  const sceneId = storeReady ? selectedScene : initialScene;
  const activeCameraViewMode = storeReady ? cameraViewMode : initialCameraViewMode;
  const scene = sceneById[sceneId];

  useEffect(() => {
    setSelectedScene(initialScene);
    setCameraViewMode(initialCameraViewMode);
    setStoreReady(true);
  }, [initialCameraViewMode, initialScene, setCameraViewMode, setSelectedScene]);

  useEffect(() => {
    document.title = `Agent HQ | ${scene.label}`;
  }, [scene.label]);

  const selectScene = (nextScene: HqSceneId) => {
    setSelectedScene(nextScene);
    const nextUrl = new URL(window.location.href);
    nextUrl.pathname = "/";
    nextUrl.searchParams.set("scene", nextScene);
    window.history.replaceState(null, "", nextUrl);
  };

  return (
    <main className="workspace-shell">
      <HqRoomScene
        key={sceneId}
        initialCharacter={initialCharacter}
        manifest={scene.manifest}
        startPosition={startPosition}
        cameraViewMode={activeCameraViewMode}
        onCameraViewModeChange={setCameraViewMode}
        accountTargetId="workspace-account-slot"
        cameraTargetId="workspace-camera-slot"
        roomDesignerTargetId="workspace-room-designer-slot"
      />

      <div className="workspace-ui" aria-label="Agent HQ workspace controls">
        <header className="workspace-topbar">
          <div className="workspace-topbar__main">
            <div className="workspace-brand">
              <div className="workspace-brand__mark" aria-hidden="true">
                <Sparkles size={16} strokeWidth={1.8} />
              </div>
              <div>
                <p className="workspace-eyebrow">AGENT OPERATIONS</p>
                <h1>Agent HQ</h1>
              </div>
            </div>

            <div className="workspace-topbar__actions">
              <div className="workspace-status" role="status">
                <span className="workspace-status__dot" aria-hidden="true" />
                <span>
                  {workspaceQuery.isPending
                    ? "Workspace syncing"
                    : workspaceQuery.isError
                      ? "Workspace offline"
                      : "Workspace online"}
                </span>
              </div>
              <ThemeToggle className="workspace-theme-toggle" />
              <div className="workspace-music-toggle" aria-label="Music controls">
                <MusicToggle />
              </div>
              <div id="workspace-account-slot" className="workspace-account-slot" />
            </div>
          </div>
          <div className="workspace-topbar__secondary">
            <nav className="workspace-scene-nav" aria-label="HQ spaces">
              {sceneOptions.map((option) => {
                const Icon = option.icon;
                const isSelected = option.id === sceneId;
                return (
                  <Button
                    key={option.id}
                    type="button"
                    className={`workspace-scene-tab${isSelected ? " workspace-scene-tab--selected" : ""}`}
                    aria-pressed={isSelected}
                    variant={isSelected ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => selectScene(option.id)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {option.label}
                  </Button>
                );
              })}
            </nav>
            <div id="workspace-room-designer-slot" className="workspace-room-designer-slot" />
          </div>
        </header>

        {isDetailsPanelOpen ? (
          <Card className="workspace-details" aria-labelledby="workspace-details-title">
            <div className="workspace-panel-heading">
              <div>
                <p className="workspace-eyebrow">CURRENT SURFACE</p>
                <h2 id="workspace-details-title">{scene.label}</h2>
              </div>
              <Button
                type="button"
                aria-label="Close workspace details"
                onClick={() => setDetailsPanelOpen(false)}
                size="icon-sm"
                variant="ghost"
              >
                <PanelRight size={16} aria-hidden="true" />
              </Button>
            </div>
            <p className="workspace-details__description">{scene.description}</p>
            <div className="workspace-detail-section">
              <p className="workspace-eyebrow">RUNTIME</p>
              <p className="workspace-detail-section__title">Spatial workspace online.</p>
              <p className="workspace-detail-section__meta">
                Scene rendering stays inside the dedicated Three.js runtime boundary.
              </p>
            </div>
            <div className="workspace-detail-section workspace-detail-section--accent">
              <p className="workspace-eyebrow">CAMERA MODE</p>
              <p className="workspace-detail-section__title">Perspective or top-down.</p>
              <p className="workspace-detail-section__meta">
                Use the camera controls below to switch the active view.
              </p>
            </div>
          </Card>
        ) : (
          <Button
            type="button"
            className="workspace-details-reopen"
            aria-label="Open workspace details"
            onClick={() => setDetailsPanelOpen(true)}
            size="icon"
            variant="secondary"
          >
            <PanelRight size={16} aria-hidden="true" />
          </Button>
        )}

        <div className="workspace-view-switcher" aria-label="Camera view">
          <div id="workspace-camera-slot" className="workspace-tool-slot" />
        </div>

        <p className="workspace-scene-caption">
          <span className="workspace-scene-caption__dot" aria-hidden="true" />
          {scene.label} scene · Drag to orbit · Scroll to zoom
        </p>
      </div>
    </main>
  );
}
