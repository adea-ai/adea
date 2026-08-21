import { create } from "zustand";

export type ViewMode = "map" | "focus";

export interface WorkspaceState {
  characterId: string;
  isDetailsPanelOpen: boolean;
  viewMode: ViewMode;
  roomDesignerOpen: boolean;
  setCharacterId(characterId: string): void;
  toggleDetailsPanel(): void;
  setViewMode(viewMode: ViewMode): void;
  setRoomDesignerOpen(open: boolean): void;
}

export const initialWorkspaceState = {
  characterId: "cashier",
  isDetailsPanelOpen: true,
  viewMode: "map" as const,
  roomDesignerOpen: false,
};

export function createWorkspaceStore() {
  return create<WorkspaceState>((set) => ({
    ...initialWorkspaceState,
    setCharacterId: (characterId) => set({ characterId }),
    toggleDetailsPanel: () => set((state) => ({ isDetailsPanelOpen: !state.isDetailsPanelOpen })),
    setViewMode: (viewMode) => set({ viewMode }),
    setRoomDesignerOpen: (roomDesignerOpen) => set({ roomDesignerOpen }),
  }));
}

export const useWorkspaceStore = createWorkspaceStore();
