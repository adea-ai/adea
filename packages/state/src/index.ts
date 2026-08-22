import { create } from "zustand";
import type { WorkspaceSceneId, WorkspaceViewMode } from "@agent-hq/types";

export type WorkspaceState = {
  selectedScene: WorkspaceSceneId;
  cameraViewMode: WorkspaceViewMode;
  setSelectedScene: (scene: WorkspaceSceneId) => void;
  setCameraViewMode: (mode: WorkspaceViewMode) => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selectedScene: "home",
  cameraViewMode: "orthographic",
  setSelectedScene: (selectedScene) => set({ selectedScene }),
  setCameraViewMode: (cameraViewMode) => set({ cameraViewMode }),
}));
