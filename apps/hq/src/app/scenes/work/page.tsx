import type { Metadata } from "next";
import { isIthappyCharacterId, isIthappyCustomCharacterId } from "@agent-hq/ithappy";
import { readSceneStartPosition } from "@agent-hq/scene-shell/scene-spawn";
import { hqWorkManifest } from "@agent-hq/scene-hq-work";
import { HqRoomScene } from "../../../components/hq-room-scene";

export const metadata: Metadata = { title: `Agent HQ | ${hqWorkManifest.label}` };

export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<{
    character?: string | string[];
    spawn?: string | string[];
    camera?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const requested = params.character;
  const character = Array.isArray(requested) ? requested[0] : requested;
  const isValidCharacter = isIthappyCharacterId(character) || isIthappyCustomCharacterId(character);
  const characterId = isValidCharacter ? character! : "cashier";
  const cameraParam = Array.isArray(params.camera) ? params.camera[0] : params.camera;
  const cameraViewMode =
    cameraParam === "perspective" || cameraParam === "orthographic" ? cameraParam : undefined;
  return (
    <HqRoomScene
      initialCharacter={characterId}
      manifest={hqWorkManifest}
      startPosition={readSceneStartPosition(params.spawn)}
      cameraViewMode={cameraViewMode}
    />
  );
}
