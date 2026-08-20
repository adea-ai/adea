import { NextResponse } from "next/server";
import { hqHomeManifest } from "@agent-hq/scene-hq-home";
import { hqWorkManifest } from "@agent-hq/scene-hq-work";
import type { RoomLayoutDocument } from "@agent-hq/rooms";
import homeLayout from "@agent-hq/scene-hq-home/assets/rooms.json";
import workLayout from "@agent-hq/scene-hq-work/assets/rooms.json";

const defaults: Record<string, RoomLayoutDocument> = {
  [hqHomeManifest.id]: homeLayout,
  [hqWorkManifest.id]: workLayout,
};
const persisted = new Map<string, RoomLayoutDocument>();

function isValidLayout(value: unknown): value is RoomLayoutDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoomLayoutDocument>;
  return (
    candidate.version === 1 &&
    typeof candidate.scene === "string" &&
    Boolean(candidate.placements && typeof candidate.placements === "object")
  );
}

export async function GET(request: Request) {
  const scene = new URL(request.url).searchParams.get("scene") ?? "hq-home";
  const layout = persisted.get(scene) ?? defaults[scene];
  return layout
    ? NextResponse.json(layout)
    : NextResponse.json({ error: "Unknown scene" }, { status: 404 });
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (!isValidLayout(body) || !defaults[body.scene])
    return NextResponse.json({ error: "Invalid room layout" }, { status: 400 });
  const saved = {
    version: 1,
    scene: body.scene,
    placements: { ...body.placements },
  } satisfies RoomLayoutDocument;
  persisted.set(body.scene, saved);
  return NextResponse.json(saved);
}
