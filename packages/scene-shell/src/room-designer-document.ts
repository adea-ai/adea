export type RoomDesignerDocumentPlacement = {
  id?: string;
  p?: [number, number, number];
  q?: [number, number, number, number];
  s?: [number, number, number];
  footprint?: [number, number];
};

export type RoomDesignerDocument = {
  version?: number;
  scene?: string;
  placements?: Record<string, RoomDesignerDocumentPlacement[]>;
};

const documentCache = new Map<string, Promise<RoomDesignerDocument>>();

/**
 * Loads the saved placement document once per scene and shares the in-flight
 * request between the room designer and collider runtime.
 */
export function loadRoomDesignerDocument(sceneId: string): Promise<RoomDesignerDocument> {
  const cached = documentCache.get(sceneId);
  if (cached) return cached;

  const request = fetch(`/assets/worlds/${sceneId}/props.json?v=room-layout`, {
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok) return {};
      return (await response.json()) as RoomDesignerDocument;
    })
    .catch((error: unknown) => {
      documentCache.delete(sceneId);
      throw error;
    });

  documentCache.set(sceneId, request);
  return request;
}

/** Clears the session cache after a successful scene-editor save. */
export function invalidateRoomDesignerDocument(sceneId: string): void {
  documentCache.delete(sceneId);
}
