import { create } from "zustand";

export type ViewMode = "map" | "focus";
export type CameraMode = "orbit" | "pan";

export interface WorkspaceState {
  selectedAgentId: string | null;
  isDetailsPanelOpen: boolean;
  viewMode: ViewMode;
  cameraMode: CameraMode;
  selectAgent(agentId: string | null): void;
  toggleDetailsPanel(): void;
  setViewMode(viewMode: ViewMode): void;
  setCameraMode(cameraMode: CameraMode): void;
}

export const initialWorkspaceState = {
  selectedAgentId: null,
  isDetailsPanelOpen: true,
  viewMode: "map" as const,
  cameraMode: "orbit" as const,
};

export function createWorkspaceStore() {
  return create<WorkspaceState>((set) => ({
    ...initialWorkspaceState,
    selectAgent: (selectedAgentId) => set({ selectedAgentId }),
    toggleDetailsPanel: () => set((state) => ({ isDetailsPanelOpen: !state.isDetailsPanelOpen })),
    setViewMode: (viewMode) => set({ viewMode }),
    setCameraMode: (cameraMode) => set({ cameraMode }),
  }));
}

export const useWorkspaceStore = createWorkspaceStore();
