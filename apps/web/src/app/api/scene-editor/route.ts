import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const CATEGORIES = new Set(["foliage", "props"]);
const HQ_SCENES = new Set(["hq-home", "hq-work"]);
const HQ_SOURCE_DIRECTORIES = {
  "hq-home": "home",
  "hq-work": "work",
} as const;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/;

type Placement = {
  p: [number, number, number];
  q: [number, number, number, number];
  s: [number, number, number];
};

type SaveRequest = {
  scene?: unknown;
  category?: unknown;
  modelId?: unknown;
  placementIndex?: unknown;
  placement?: Partial<Placement>;
  objectPath?: unknown;
  objectName?: unknown;
  transform?: Partial<Placement>;
  roomDesigner?: {
    placements?: unknown;
  };
};

let saveQueue = Promise.resolve();

function validVector(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isSameOrigin(request: Request, requestUrl: URL): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowedOrigins = new Set([requestUrl.origin]);
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || requestUrl.protocol.slice(0, -1);
  for (const headerName of ["host", "x-forwarded-host"]) {
    for (const host of (request.headers.get(headerName) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      allowedOrigins.add(`${protocol}://${host}`);
    }
  }
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function isRoomDesignerDocument(
  value: unknown,
): value is { placements: Record<string, Placement[]> } {
  if (!value || typeof value !== "object") return false;
  const document = value as { placements?: unknown };
  if (
    !document.placements ||
    typeof document.placements !== "object" ||
    Array.isArray(document.placements)
  )
    return false;
  const placementEntries = Object.entries(document.placements as Record<string, unknown>);
  if (placementEntries.length > 64) return false;
  let placementCount = 0;
  for (const [modelId, entries] of placementEntries) {
    if (!SAFE_ID.test(modelId) || !Array.isArray(entries)) return false;
    placementCount += entries.length;
    if (placementCount > 500) return false;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") return false;
      const placement = entry as Partial<Placement>;
      if (
        !validVector(placement.p, 3) ||
        !validVector(placement.q, 4) ||
        !validVector(placement.s, 3)
      )
        return false;
    }
  }
  return true;
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return new NextResponse(null, { status: 404 });

  const requestUrl = new URL(request.url);
  if (!isSameOrigin(request, requestUrl)) {
    return NextResponse.json({ error: "Scene editor saves must be same-origin." }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Scene editor saves require JSON." }, { status: 415 });
  }

  const body = (await request.json()) as SaveRequest;
  const isPlacement =
    typeof body.category === "string" &&
    CATEGORIES.has(body.category) &&
    typeof body.modelId === "string" &&
    SAFE_ID.test(body.modelId) &&
    Number.isInteger(body.placementIndex) &&
    (body.placementIndex as number) >= 0 &&
    validVector(body.placement?.p, 3) &&
    validVector(body.placement?.q, 4) &&
    validVector(body.placement?.s, 3);
  const isObject =
    typeof body.objectPath === "string" &&
    body.objectPath.length > 0 &&
    body.objectPath.length <= 2000 &&
    !body.objectPath.includes("\0") &&
    (body.objectName == null ||
      (typeof body.objectName === "string" && body.objectName.length <= 500)) &&
    validVector(body.transform?.p, 3) &&
    validVector(body.transform?.q, 4) &&
    validVector(body.transform?.s, 3);
  const isRoomDesigner = isRoomDesignerDocument(body.roomDesigner);
  if (
    typeof body.scene !== "string" ||
    !HQ_SCENES.has(body.scene) ||
    (!isPlacement && !isObject && !isRoomDesigner)
  ) {
    return NextResponse.json({ error: "Invalid HQ scene placement payload." }, { status: 400 });
  }

  const sourceDirectory = HQ_SOURCE_DIRECTORIES[body.scene as keyof typeof HQ_SOURCE_DIRECTORIES];
  const relativePath = isRoomDesigner
    ? path.join("scenes", "hq", "assets", sourceDirectory, "props.json")
    : isPlacement
      ? path.join("scenes", "hq", "assets", sourceDirectory, `${body.category}.json`)
      : path.join("scenes", "hq", "assets", sourceDirectory, "editor-overrides.json");
  const repoRoot = await findRepoRoot(process.cwd());
  const sourcePath = path.resolve(repoRoot, relativePath);
  if (!sourcePath.startsWith(`${repoRoot}${path.sep}`)) {
    return NextResponse.json({ error: "Invalid scene path." }, { status: 400 });
  }

  try {
    saveQueue = saveQueue
      .catch(() => undefined)
      .then(async () => {
        const sourceBytes = await readFile(sourcePath, "utf8").catch((error) => {
          if (
            isRoomDesigner &&
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return JSON.stringify({ version: 1, scene: body.scene, placements: {} });
          }
          if (isObject && error instanceof Error && "code" in error && error.code === "ENOENT") {
            return '{\n  "version": 1,\n  "objects": {}\n}\n';
          }
          throw error;
        });
        const manifest = JSON.parse(sourceBytes) as {
          version?: number;
          placements?: Record<string, Placement[]>;
          objects?: Record<string, { name?: string; transform: Placement }>;
        };
        let nextBytes: string;
        if (isRoomDesigner) {
          nextBytes = `${JSON.stringify(
            {
              version: 1,
              scene: body.scene,
              placements: body.roomDesigner?.placements,
            },
            null,
            1,
          )}\n`;
        } else if (isPlacement) {
          const placements = manifest.placements?.[body.modelId as string];
          const placementIndex = body.placementIndex as number;
          if (!placements?.[placementIndex]) throw new PlacementNotFoundError();
          placements[placementIndex] = body.placement as Placement;
          nextBytes = `${JSON.stringify(manifest, null, 1)}\n`;
        } else {
          manifest.version = 1;
          manifest.objects ??= {};
          manifest.objects[body.objectPath as string] = {
            ...(typeof body.objectName === "string" ? { name: body.objectName } : {}),
            transform: body.transform as Placement,
          };
          nextBytes = `${JSON.stringify(manifest, null, 1)}\n`;
        }
        const publicManifestPath = path.join(
          repoRoot,
          "apps",
          "web",
          "public",
          "assets",
          "worlds",
          body.scene as string,
          isRoomDesigner
            ? "props.json"
            : isPlacement
              ? `${body.category}.json`
              : "editor-overrides.json",
        );
        const previousPublicBytes = await readFile(publicManifestPath, "utf8").catch(() => null);
        try {
          await atomicWrite(publicManifestPath, nextBytes);
          await atomicWrite(sourcePath, nextBytes);
        } catch (error) {
          if (previousPublicBytes != null)
            await atomicWrite(publicManifestPath, previousPublicBytes);
          throw error;
        }
      });
    await saveQueue;
    return NextResponse.json({ path: relativePath });
  } catch (error) {
    if (error instanceof PlacementNotFoundError) {
      return NextResponse.json(
        { error: "Placement was not found in the HQ scene manifest." },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save HQ scene placement." },
      { status: 500 },
    );
  }
}

class PlacementNotFoundError extends Error {}

async function atomicWrite(destination: string, contents: string): Promise<void> {
  const temporaryPath = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, destination);
}

async function findRepoRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try {
      const packageJson = JSON.parse(
        await readFile(path.join(current, "package.json"), "utf8"),
      ) as { name?: string };
      if (packageJson.name === "agent-hq") return current;
    } catch {
      // Continue upward until the repository root is found.
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not locate the Agent HQ repository root.");
    current = parent;
  }
}
