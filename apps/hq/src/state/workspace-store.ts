import { create } from "zustand";

export type ViewMode = "map" | "focus";
export type CameraMode = "perspective" | "orthographic";

export interface WorkspaceState {
  selectedAgentId: string | null;
  sceneId: "hq-home" | "hq-work";
  characterId: string;
  isDetailsPanelOpen: boolean;
  viewMode: ViewMode;
  cameraMode: CameraMode;
  roomDesignerOpen: boolean;
  selectAgent(agentId: string | null): void;
  setSceneId(sceneId: "hq-home" | "hq-work"): void;
  setCharacterId(characterId: string): void;
  toggleDetailsPanel(): void;
  setViewMode(viewMode: ViewMode): void;
  setCameraMode(cameraMode: CameraMode): void;
  setRoomDesignerOpen(open: boolean): void;
}

export const initialWorkspaceState = {
  selectedAgentId: null,
  sceneId: "hq-home" as const,
  characterId: "cashier",
  isDetailsPanelOpen: true,
  viewMode: "map" as const,
  cameraMode: "orthographic" as const,
  roomDesignerOpen: false,
};

export function createWorkspaceStore() {
  return create<WorkspaceState>((set) => ({
    ...initialWorkspaceState,
    selectAgent: (selectedAgentId) => set({ selectedAgentId }),
    setSceneId: (sceneId) => set({ sceneId, roomDesignerOpen: false }),
    setCharacterId: (characterId) => set({ characterId }),
    toggleDetailsPanel: () => set((state) => ({ isDetailsPanelOpen: !state.isDetailsPanelOpen })),
    setViewMode: (viewMode) => set({ viewMode }),
    setCameraMode: (cameraMode) => set({ cameraMode }),
    setRoomDesignerOpen: (roomDesignerOpen) => set({ roomDesignerOpen }),
  }));
}

export const useWorkspaceStore = createWorkspaceStore();
