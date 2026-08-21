"use client";

import { useQueryStates } from "nuqs";

import type { HqCameraMode, HqSceneId } from "@agent-hq/scene-runtime";
import { workspaceUrlParsers } from "./workspace-url-schema";

export function useWorkspaceUrlState() {
  const [urlState, setUrlState] = useQueryStates(workspaceUrlParsers, {
    clearOnDefault: true,
    shallow: true,
  });

  return {
    sceneId: urlState.scene,
    cameraMode: urlState.camera,
    selectedAgentId: urlState.agent,
    setSceneId: (sceneId: HqSceneId) => setUrlState({ scene: sceneId }),
    setCameraMode: (cameraMode: HqCameraMode) => setUrlState({ camera: cameraMode }),
    setSelectedAgentId: (selectedAgentId: string | null) => setUrlState({ agent: selectedAgentId }),
  };
}
