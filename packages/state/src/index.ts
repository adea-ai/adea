import { create } from "zustand";
import type { WorkspaceSceneId, WorkspaceViewMode } from "@agent-hq/types";

export type WorkspaceState = {
  selectedScene: WorkspaceSceneId;
  cameraViewMode: WorkspaceViewMode;
  detailsPanelOpen: boolean;
  roomDesignerOpen: boolean;
  setSelectedScene: (scene: WorkspaceSceneId) => void;
  setCameraViewMode: (mode: WorkspaceViewMode) => void;
  setDetailsPanelOpen: (open: boolean) => void;
  setRoomDesignerOpen: (open: boolean) => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selectedScene: "home",
  cameraViewMode: "orthographic",
  detailsPanelOpen: true,
  roomDesignerOpen: false,
  setSelectedScene: (selectedScene) => set({ selectedScene }),
  setCameraViewMode: (cameraViewMode) => set({ cameraViewMode }),
  setDetailsPanelOpen: (detailsPanelOpen) => set({ detailsPanelOpen }),
  setRoomDesignerOpen: (roomDesignerOpen) => set({ roomDesignerOpen }),
}));
