"use client";

import { memo, useEffect, useRef, useState } from "react";

import {
  createHqSceneRuntime,
  type HqCameraMode,
  type HqSceneId,
  type HqSceneState,
} from "@agent-hq/scene-runtime";
import type { RoomLayoutDocument } from "@agent-hq/rooms";

export const SceneViewport = memo(function SceneViewport({
  sceneId,
  characterId,
  cameraMode,
  layout,
  designerOpen,
}: {
  sceneId: HqSceneId;
  characterId: string;
  cameraMode: HqCameraMode;
  layout: RoomLayoutDocument;
  designerOpen: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ReturnType<typeof createHqSceneRuntime> | null>(null);
  const initialConfigRef = useRef({ cameraMode, characterId, layout });
  const [sceneState, setSceneState] = useState<HqSceneState | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const initialConfig = initialConfigRef.current;

    const runtime = createHqSceneRuntime({
      sceneId,
      characterId: initialConfig.characterId,
      cameraMode: initialConfig.cameraMode,
      initialLayout: initialConfig.layout,
      onStateChange: setSceneState,
    });
    runtimeRef.current = runtime;
    runtime.mount(viewport);

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;

      runtime.resize(entry.contentRect.width, entry.contentRect.height, window.devicePixelRatio);
    });
    resizeObserver.observe(viewport);

    return () => {
      resizeObserver.disconnect();
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [sceneId]);

  useEffect(() => {
    if (!runtimeRef.current) return;
    runtimeRef.current.setCameraMode(cameraMode);
  }, [cameraMode]);

  useEffect(() => {
    if (!runtimeRef.current) return;
    void runtimeRef.current.setCharacter(characterId).catch(() => undefined);
  }, [characterId]);

  useEffect(() => {
    if (!runtimeRef.current || designerOpen) return;
    void runtimeRef.current.setRoomLayout(layout).catch(() => undefined);
  }, [designerOpen, layout]);

  return (
    <div
      ref={viewportRef}
      aria-label="Spatial workspace scene"
      className="scene-viewport"
      role="img"
    >
      <div className="scene-viewport__overlay" aria-hidden="true">
        <span className="scene-viewport__grid-label">
          {sceneState?.status === "loading" ? "LOADING HQ" : "LIVE SPATIAL VIEW"}
        </span>
        <span className="scene-viewport__coordinates">
          {sceneState
            ? `X ${sceneState.position.x.toFixed(0)} / Z ${sceneState.position.z.toFixed(0)} · ${sceneState.roomCount} rooms`
            : "Connecting to scene runtime…"}
        </span>
      </div>
      {sceneState?.status === "error" ? (
        <p className="scene-viewport__error">{sceneState.message}</p>
      ) : null}
    </div>
  );
});
