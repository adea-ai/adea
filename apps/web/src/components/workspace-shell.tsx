"use client";

import { useEffect, useState } from "react";
import { createApiClient } from "@agent-hq/api-client";
import type { HqSceneId } from "@agent-hq/app-core";
import { MusicToggle } from "@agent-hq/audio";
import { useWorkspaceQuery } from "@agent-hq/data";
import { useWorkspaceStore } from "@agent-hq/state";
import { BriefcaseBusiness, Home, Sparkles } from "lucide-react";
import { hqHomeManifest, hqWorkManifest } from "@agent-hq/hq-scenes";
import type { SceneStartPosition } from "@agent-hq/asset-manifests";
import { Button, ThemeToggle } from "@agent-hq/ui";
import { HqRoomScene } from "./hq-room-scene";

const sceneOptions = [
  {
    id: "home" as const,
    label: "Home",
    eyebrow: "ROOM 01",
    icon: Home,
    manifest: hqHomeManifest,
  },
  {
    id: "work" as const,
    label: "Work",
    eyebrow: "ROOM 02",
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
        roomDesignerTargetId="workspace-scene-tools-slot"
        sceneEditorTargetId="workspace-scene-tools-slot"
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
          </div>
        </header>

        <div
          id="workspace-scene-tools-slot"
          className="workspace-scene-tools"
          role="group"
          aria-label="Scene tools"
        />

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
