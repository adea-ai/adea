import { parseAsString, parseAsStringEnum } from "nuqs";

import type { HqCameraMode, HqSceneId } from "@agent-hq/scene-runtime";

export const workspaceSceneIds = ["hq-home", "hq-work"] as HqSceneId[];
export const workspaceCameraModes = ["perspective", "orthographic"] as HqCameraMode[];

export const workspaceUrlParsers = {
  scene: parseAsStringEnum<HqSceneId>(workspaceSceneIds)
    .withDefault("hq-home")
    .withOptions({ history: "push" }),
  camera: parseAsStringEnum<HqCameraMode>(workspaceCameraModes)
    .withDefault("orthographic")
    .withOptions({ history: "push" }),
  agent: parseAsString.withOptions({ history: "replace" }),
};
