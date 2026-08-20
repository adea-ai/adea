"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoomLayoutDocument } from "@agent-hq/rooms";
import type { HqSceneId } from "./hq-scene";

async function fetchLayout(sceneId: HqSceneId): Promise<RoomLayoutDocument> {
  const response = await fetch(`/api/layout?scene=${sceneId}`, { cache: "no-store" });
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

export function useHqLayoutQuery(sceneId: HqSceneId) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["hq-layout", sceneId], queryFn: () => fetchLayout(sceneId) });
  const mutation = useMutation({
    mutationFn: saveLayout,
    onSuccess: (saved) => queryClient.setQueryData(["hq-layout", sceneId], saved),
  });
  return { ...query, saveLayout: mutation.mutateAsync, isSaving: mutation.isPending };
}
