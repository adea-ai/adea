import { hqHomeManifest, hqWorkManifest } from "@agent-hq/hq-scenes";
import { configurableCharacterId } from "@agent-hq/characters/runtime";
import type { AgentHqApiClient } from "@agent-hq/api-client";
import { VirtualRoomControls, type WorkspaceView } from "@agent-hq/workspace-ui";
import { lazy, Suspense, useEffect, useState } from "react";

const HqRoomScene = lazy(() =>
  import("@agent-hq/hq-scenes/runtime").then(({ HqRoomScene: Scene }) => ({ default: Scene }))
);
const RoomDesignerScene = lazy(() =>
  import("@agent-hq/room-designer-scene").then(({ RoomDesignerScene: Scene }) => ({
    default: Scene,
  }))
);
const DesktopCharacterDesigner = lazy(() =>
  import("./desktop-character-designer").then(({ DesktopCharacterDesigner: Designer }) => ({
    default: Designer,
  }))
);

function SceneLoading() {
  return (
    <main className="workspace-shell conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  );
}

type DesktopWorkspaceProps = Readonly<{
  client: AgentHqApiClient;
  onWorkspaceViewChange(view: WorkspaceView): void;
  scene: "home" | "work";
}>;

export function DesktopWorkspace({ client, onWorkspaceViewChange, scene }: DesktopWorkspaceProps) {
  const manifest = scene === "work" ? hqWorkManifest : hqHomeManifest;
  const searchParams =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const characterDesigner =
    searchParams !== null &&
    searchParams.get("characterDesigner") !== null &&
    searchParams.get("characterDesigner") !== "0";
  const roomDesigner =
    searchParams !== null &&
    searchParams.get("roomDesigner") !== null &&
    searchParams.get("roomDesigner") !== "0";
  const [roomDesignerEnabled, setRoomDesignerEnabled] = useState(roomDesigner);

  useEffect(() => {
    setRoomDesignerEnabled(roomDesigner);
  }, [roomDesigner]);

  const setRoomDesignerRoute = (enabled: boolean) => {
    setRoomDesignerEnabled(enabled);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("roomDesigner", enabled ? "1" : "0");
    window.history.replaceState(null, "", nextUrl);
  };

  if (characterDesigner) {
    return (
      <Suspense fallback={<SceneLoading />}>
        <DesktopCharacterDesigner />
      </Suspense>
    );
  }

  return (
    <main className="workspace-shell">
      <div className="workspace-scene-viewport">
        <Suspense fallback={<SceneLoading />}>
          {roomDesignerEnabled ? (
            <RoomDesignerScene
              initialCharacter={configurableCharacterId}
              initialScene={scene}
              onClose={() => setRoomDesignerRoute(false)}
            />
          ) : (
            <HqRoomScene
              key={scene}
              initialCharacter={configurableCharacterId}
              manifest={manifest}
              cameraViewMode="orthographic"
              showAccountDrawer={false}
              onOpenRoomDesigner={() => setRoomDesignerRoute(true)}
            />
          )}
        </Suspense>
        {!roomDesignerEnabled ? (
          <div className="workspace-ui" aria-label="Agent HQ workspace controls">
            <VirtualRoomControls client={client} openChat={() => onWorkspaceViewChange("chat")} />

            <div
              id="workspace-scene-tools-slot"
              className="workspace-scene-tools"
              role="group"
              aria-label="Scene tools"
            />
            <div className="workspace-view-switcher" aria-label="Camera view">
              <div id="workspace-camera-slot" className="workspace-tool-slot" />
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
