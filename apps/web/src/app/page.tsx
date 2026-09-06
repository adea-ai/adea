import type { Metadata } from "next";
import { hqSceneFromSearchParams } from "@adea/app-core";
import { configurableCharacterId, isPlausibleCharacterId } from "@adea/spatial-protocol";
import { readSceneStartPosition } from "@adea/spatial-protocol";
import { WorkspaceEntry } from "../components/workspace-entry";

export const metadata: Metadata = {
  title: "Agent HQ",
  description: "A durable workspace for Rooms, Agents, Tasks, and conversations",
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    camera?: string | string[];
    character?: string | string[];
    scene?: string | string[];
    spawn?: string | string[];
    view?: string | string[];
    characterDesigner?: string | string[];
    roomDesigner?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const requestedCharacter = Array.isArray(params.character)
    ? params.character[0]
    : params.character;
  const isValidCharacter = isPlausibleCharacterId(requestedCharacter);
  const cameraParam = Array.isArray(params.camera) ? params.camera[0] : params.camera;
  const view = Array.isArray(params.view) ? params.view[0] : params.view;
  const characterDesigner = Array.isArray(params.characterDesigner)
    ? params.characterDesigner[0]
    : params.characterDesigner;
  const roomDesigner = Array.isArray(params.roomDesigner)
    ? params.roomDesigner[0]
    : params.roomDesigner;

  return (
    <WorkspaceEntry
      virtual={view === "virtual" || (roomDesigner !== undefined && roomDesigner !== "0")}
      characterDesigner={characterDesigner !== undefined && characterDesigner !== "0"}
      roomDesigner={roomDesigner !== undefined && roomDesigner !== "0"}
      virtualProps={{
        initialScene: hqSceneFromSearchParams(params),
        initialCharacter: isValidCharacter ? requestedCharacter! : configurableCharacterId,
        startPosition: readSceneStartPosition(params.spawn),
        cameraViewMode:
          cameraParam === "perspective" || cameraParam === "orthographic" ? cameraParam : undefined,
      }}
    />
  );
}
