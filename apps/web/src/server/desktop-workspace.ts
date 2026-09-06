const DESKTOP_CLIENT = "desktop";
const PRODUCTION_DESKTOP_ORIGINS = Object.freeze([
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
]);
const DEVELOPMENT_DESKTOP_ORIGIN = "http://127.0.0.1:1420";

export function desktopTrustedOrigins(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.DESKTOP_AUTH_TRUSTED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = configured?.length
    ? [...configured, DEVELOPMENT_DESKTOP_ORIGIN]
    : [...PRODUCTION_DESKTOP_ORIGINS, DEVELOPMENT_DESKTOP_ORIGIN];
  if (
    origins.some(
      (origin) =>
        origin.includes("*") ||
        origin.includes("@") ||
        origin.endsWith("/") ||
        !/^(?:https?:\/\/|tauri:\/\/)[A-Za-z0-9.:[\]-]+$/u.test(origin)
    )
  ) {
    throw new Error("Desktop auth trusted origins are invalid");
  }
  return Object.freeze([...new Set(origins)]);
}

function markedDesktopRequest(request: Request) {
  return request.headers.get("x-adea-client") === DESKTOP_CLIENT;
}

export function trustedDesktopWorkspaceRequest(
  request: Request,
  trustedOrigins: readonly string[]
) {
  return (
    markedDesktopRequest(request) && trustedOrigins.includes(request.headers.get("origin") ?? "")
  );
}

export function rejectUntrustedDesktopWorkspaceRequest(
  request: Request,
  trustedOrigins: readonly string[]
): Response | null {
  if (!markedDesktopRequest(request) || trustedDesktopWorkspaceRequest(request, trustedOrigins)) {
    return null;
  }
  return Response.json(
    { code: "workspace_unavailable", message: "Workspace unavailable" },
    { headers: { "cache-control": "no-store", vary: "Origin" }, status: 403 }
  );
}

export function desktopWorkspacePreflight(request: Request, trustedOrigins: readonly string[]) {
  const origin = request.headers.get("origin") ?? "";
  if (!trustedOrigins.includes(origin)) {
    return Response.json(
      { code: "workspace_unavailable", message: "Workspace unavailable" },
      { headers: { "cache-control": "no-store", vary: "Origin" }, status: 403 }
    );
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-headers":
        "Authorization, Content-Type, Idempotency-Key, X-Adea-Client, X-Adea-Desktop-Session, X-Adea-Temporary-Session",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin",
    },
  });
}

export function applyDesktopWorkspaceCors(
  response: Response,
  request: Request,
  trustedOrigins: readonly string[]
) {
  if (!trustedDesktopWorkspaceRequest(request, trustedOrigins)) return response;
  response.headers.set("access-control-allow-origin", request.headers.get("origin")!);
  const vary = response.headers.get("vary");
  response.headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  return response;
}

export function guardDesktopWorkspaceRequest(request: Request) {
  return rejectUntrustedDesktopWorkspaceRequest(request, desktopTrustedOrigins());
}

export function handleDesktopWorkspacePreflight(request: Request) {
  return desktopWorkspacePreflight(request, desktopTrustedOrigins());
}

export function withDesktopWorkspaceCors(response: Response, request: Request) {
  return applyDesktopWorkspaceCors(response, request, desktopTrustedOrigins());
}
