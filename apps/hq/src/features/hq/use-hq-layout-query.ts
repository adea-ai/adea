"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoomLayoutDocument } from "@agent-hq/rooms";
import type { HqSceneId } from "./hq-scene";

async function fetchLayout(sceneId: HqSceneId, signal: AbortSignal): Promise<RoomLayoutDocument> {
  const response = await fetch(`/api/layout?scene=${sceneId}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Unable to load the room layout.");
  return response.json() as Promise<RoomLayoutDocument>;
}

async function saveLayout(layout: RoomLayoutDocument): Promise<RoomLayoutDocument> {
  const response = await fetch("/api/layout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(layout),
  });
  if (!response.ok) throw new Error("Unable to save the room layout.");
  return response.json() as Promise<RoomLayoutDocument>;
}

export const hqLayoutQueryKey = (sceneId: HqSceneId) => ["hq-layout", sceneId] as const;

export function useHqLayoutQuery(sceneId: HqSceneId) {
  const queryClient = useQueryClient();
  const query = useQuery({
    gcTime: 30 * 60_000,
    queryKey: hqLayoutQueryKey(sceneId),
    queryFn: ({ signal }) => fetchLayout(sceneId, signal),
    retry: 1,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: saveLayout,
    onSuccess: (saved) => queryClient.setQueryData(hqLayoutQueryKey(sceneId), saved),
  });
  return { ...query, saveLayout: mutation.mutateAsync, isSaving: mutation.isPending };
}
