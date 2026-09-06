"use client";

import { useEffect, useState } from "react";
import { useWorkspaceStore, type WorkspaceState } from "@adea/state";

import { createWorkspaceStatePersister } from "./workspace-state-persister";

const STORAGE_KEY = "agent-hq:conventional-workspace:v2";
type PersistedState = Pick<
  WorkspaceState,
  | "activeSurface"
  | "collapsedRoomIds"
  | "drafts"
  | "selectedAgentId"
  | "selectedChannelId"
  | "selectedRoomId"
  | "selectedTaskId"
  | "selectedWorkspaceId"
  | "threadRootMessageId"
>;

function persistedState(state: WorkspaceState): PersistedState {
  return {
    activeSurface: state.activeSurface,
    collapsedRoomIds: state.collapsedRoomIds,
    drafts: state.drafts,
    selectedAgentId: state.selectedAgentId,
    selectedChannelId: state.selectedChannelId,
    selectedRoomId: state.selectedRoomId,
    selectedTaskId: state.selectedTaskId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    threadRootMessageId: state.threadRootMessageId,
  };
}

export function useWorkspacePersistence() {
  const restore = useWorkspaceStore((state) => state.restoreConventionalState);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) restore(JSON.parse(saved) as Partial<PersistedState>);
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setReady(true);
  }, [restore]);

  useEffect(() => {
    if (!ready) return;
    const persister = createWorkspaceStatePersister((state) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState(state)));
      } catch {
        // Private browsing or storage pressure must not break the workspace.
      }
    });
    const writeNow = (state: WorkspaceState) => persister.save(state);
    writeNow(useWorkspaceStore.getState());
    const unsubscribe = useWorkspaceStore.subscribe(writeNow);
    // The debounced write must not lose the latest state when the app goes
    // away before the timer fires.
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") persister.flush();
    };
    window.addEventListener("pagehide", persister.flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", persister.flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      persister.flush();
    };
  }, [ready]);

  return ready;
}
