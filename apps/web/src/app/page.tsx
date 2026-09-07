import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createNeonServerAdapter } from "@adea-ai/auth/server";
import { hqSceneFromSearchParams } from "@adea-ai/app-core";
import { configurableCharacterId, isPlausibleCharacterId } from "@adea-ai/spatial-protocol";
import { readSceneStartPosition } from "@adea-ai/spatial-protocol";

import { emailAllowlistConfigured, isAllowedEmail } from "../server/allowed-emails";
import { WorkspaceEntry } from "../components/workspace-entry";

export const metadata: Metadata = {
  title: "Adea",
  description: "A durable workspace for Rooms, Agents, Tasks, and conversations",
};

function EarlyAccessNotice() {
  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="early-access-title">
        <p className="auth-eyebrow">Adea</p>
        <h1 className="auth-title" id="early-access-title">
          Adea is in early access
        </h1>
        <p className="auth-introduction" role="status">
          Please reach out on github if you&apos;d like to contribute.
        </p>
        <a
          className="browser-auth-submit browser-auth-open-app"
          href="https://github.com/adea-ai/adea"
          target="_blank"
          rel="noreferrer"
        >
          Adea on GitHub
        </a>
      </section>
    </main>
  );
}

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
  // Account allowlist: when configured, the workspace requires sign-in with a
  // listed email. Unsigned visitors are sent to sign-in; signed-in accounts
  // that are not on the list see the early-access notice.
  if (emailAllowlistConfigured()) {
    let email: string | null | undefined;
    try {
      const authentication = await createNeonServerAdapter().getSession();
      email = authentication?.profile.email ?? null;
    } catch {
      email = null;
    }
    if (!email) redirect("/auth/sign-in");
    if (!isAllowedEmail(email)) return <EarlyAccessNotice />;
  }

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
