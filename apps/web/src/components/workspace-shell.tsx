"use client";

import dynamic from "next/dynamic";
import { Profiler, type ProfilerOnRenderCallback, useEffect, useState } from "react";
import { createApiClient } from "@agent-hq/api-client";
import type { HqSceneId } from "@agent-hq/app-core";
import { MusicToggle } from "@agent-hq/audio";
import { useWorkspaceQuery } from "@agent-hq/data";
import { useWorkspaceStore } from "@agent-hq/state";
import { BriefcaseBusiness, Home } from "lucide-react";
import { hqHomeManifest, hqWorkManifest } from "@agent-hq/hq-scenes";
import type { SceneStartPosition } from "@agent-hq/asset-manifests";
import { Button } from "@agent-hq/ui/components/ui/button";
import { ThemeToggle } from "@agent-hq/ui/components/theme-toggle";
import { isDesktopRuntime } from "../lib/desktop-update";
import { VersionDialog } from "./version-dialog";

const HqRoomScene = dynamic(() => import("./hq-room-scene").then((module) => module.HqRoomScene), {
  ssr: false,
});

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

const recordReactCommit: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  const target = window as Window & {
    __AGENT_HQ_REACT_PROFILE__?: Array<{
      id: string;
      phase: "mount" | "update";
      actualDurationMs: number;
      baseDurationMs: number;
      startTime: number;
      commitTime: number;
    }>;
  };
  const entries = target.__AGENT_HQ_REACT_PROFILE__ ?? [];
  entries.push({
    id,
    phase: phase === "mount" ? "mount" : "update",
    actualDurationMs: actualDuration,
    baseDurationMs: baseDuration,
    startTime,
    commitTime,
  });
  if (entries.length > 100) entries.splice(0, entries.length - 100);
  target.__AGENT_HQ_REACT_PROFILE__ = entries;
};

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
  const [desktopRuntime, setDesktopRuntime] = useState(false);
  const [apiClient] = useState(() => createApiClient());
  const workspaceQuery = useWorkspaceQuery(apiClient, "default");
  const sceneId = storeReady ? selectedScene : initialScene;
  const activeCameraViewMode = storeReady ? cameraViewMode : initialCameraViewMode;
  const scene = sceneById[sceneId];
  const workspaceStatus = workspaceQuery.isPending
    ? "Workspace syncing"
    : workspaceQuery.isError
      ? "Workspace offline"
      : "Workspace online";

  useEffect(() => {
    setSelectedScene(initialScene);
    setCameraViewMode(initialCameraViewMode);
    setStoreReady(true);
  }, [initialCameraViewMode, initialScene, setCameraViewMode, setSelectedScene]);

  useEffect(() => {
    setDesktopRuntime(isDesktopRuntime());
  }, []);

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
      <Profiler id="hq-room-scene" onRender={recordReactCommit}>
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
      </Profiler>

      <div className="workspace-ui" aria-label="Agent HQ workspace controls">
        <header className="workspace-topbar">
          <div className="workspace-topbar__main">
            <div className="workspace-brand">
              <div className="workspace-brand__mark" aria-hidden="true">
                <span>HQ</span>
              </div>
              <div>
                <p className="workspace-eyebrow">AGENT OPERATIONS</p>
                <h1>Agent HQ</h1>
              </div>
            </div>

            <div className="workspace-topbar__actions">
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
          {scene.label} scene · Drag to orbit · Zoom controls
        </p>

        {desktopRuntime ? (
          <footer className="workspace-statusbar" aria-label="Agent HQ status bar">
            <div className="workspace-statusbar__meta" role="status" aria-live="polite">
              <span className="workspace-status__dot" aria-hidden="true" />
              <span>{workspaceStatus}</span>
            </div>
            <VersionDialog />
          </footer>
        ) : null}
      </div>
    </main>
  );
}
