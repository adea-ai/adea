import type { SceneStartPosition } from "@adea-ai/asset-manifests";

export type SceneApp = "world" | "hq";

const SPAWN_QUERY_KEY = "spawn";
const APP_DEV_PORTS: Record<SceneApp, string> = { world: "3000", hq: "3004" };
const APP_PORTLESS_URLS: Record<SceneApp, string> = {
  world: "https://world.localhost",
  hq: "https://adea.localhost",
};

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function finiteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Encode a scene start position for a cross-app navigation URL. */
export function encodeSceneStartPosition(position: SceneStartPosition): string {
  return [
    position.x,
    position.y,
    position.z,
    position.yaw ?? "",
    position.pitch ?? "",
    position.snapToGround == null ? "" : position.snapToGround ? "1" : "0",
  ].join(",");
}

/** Parse a validated scene start position from a route's `spawn` query. */
export function readSceneStartPosition(
  value: string | string[] | undefined
): SceneStartPosition | undefined {
  const parts = firstValue(value)?.split(",");
  if (!parts || parts.length < 3 || parts.length > 6) return undefined;
  const x = finiteNumber(parts[0]);
  const y = finiteNumber(parts[1]);
  const z = finiteNumber(parts[2]);
  if (x == null || y == null || z == null) return undefined;
  const yaw = finiteNumber(parts[3]);
  const pitch = finiteNumber(parts[4]);
  const snap = parts[5];
  if (parts[3] && yaw == null) return undefined;
  if (parts[4] && pitch == null) return undefined;
  if (snap && snap !== "0" && snap !== "1") return undefined;
  return {
    x,
    y,
    z,
    ...(yaw == null ? {} : { yaw }),
    ...(pitch == null ? {} : { pitch }),
    ...(snap === "0" ? { snapToGround: false } : snap === "1" ? { snapToGround: true } : {}),
  };
}

function configuredAppBase(app: SceneApp): string | undefined {
  const configured =
    app === "world" ? process.env.NEXT_PUBLIC_ADEA_WORLD_URL : process.env.NEXT_PUBLIC_ADEA_HQ_URL;
  return configured?.trim() || undefined;
}

function isDevelopmentHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "amf-mb-pro" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".ts.net")
  );
}

/** Resolve a route for the sibling World or HQ app in dev and production. */
export function appRouteHref(app: SceneApp, path: string, currentHref?: string): string {
  const current = new URL(currentHref ?? window.location.href);
  const configuredBase = configuredAppBase(app);
  const isPortlessHost = current.hostname.endsWith(".localhost");
  const target = new URL(
    path,
    configuredBase ?? (isPortlessHost ? APP_PORTLESS_URLS[app] : current.origin)
  );
  if (!configuredBase && !isPortlessHost && isDevelopmentHost(current.hostname)) {
    target.port = APP_DEV_PORTS[app];
  }
  return target.toString();
}

export type PortalNavigation = {
  app: SceneApp;
  path: string;
  spawn?: SceneStartPosition;
};

/** Build a portal URL while carrying the selected character and target spawn. */
export function portalNavigationHref(navigation: PortalNavigation, currentHref?: string): string {
  const current = new URL(currentHref ?? window.location.href);
  const target = new URL(appRouteHref(navigation.app, navigation.path, current.toString()));
  const character = current.searchParams.get("character");
  if (character) target.searchParams.set("character", character);
  if (navigation.spawn)
    target.searchParams.set(SPAWN_QUERY_KEY, encodeSceneStartPosition(navigation.spawn));
  return target.toString();
}
