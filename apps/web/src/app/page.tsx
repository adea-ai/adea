import type { Metadata } from "next";
import { isModelsCharacterId, isModelsCustomCharacterId } from "@agent-hq/models";
import { readSceneStartPosition } from "@agent-hq/scene-shell/scene-spawn";
import { WorkspaceShell } from "../components/workspace-shell";
import { hqSceneFromSearchParams } from "../lib/workspace-scene";

export const metadata: Metadata = {
  title: "Agent HQ",
  description: "Agent HQ spatial workspace",
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    camera?: string | string[];
    character?: string | string[];
    scene?: string | string[];
    spawn?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const requestedCharacter = Array.isArray(params.character)
    ? params.character[0]
    : params.character;
  const isValidCharacter =
    isModelsCharacterId(requestedCharacter) || isModelsCustomCharacterId(requestedCharacter);
  const cameraParam = Array.isArray(params.camera) ? params.camera[0] : params.camera;

  return (
    <WorkspaceShell
      initialScene={hqSceneFromSearchParams(params)}
      initialCharacter={isValidCharacter ? requestedCharacter! : "cashier"}
      startPosition={readSceneStartPosition(params.spawn)}
      cameraViewMode={
        cameraParam === "perspective" || cameraParam === "orthographic" ? cameraParam : undefined
      }
    />
  );
}
