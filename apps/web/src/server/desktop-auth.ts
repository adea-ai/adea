import "server-only";

import {
  consumeDesktopAuthorizationCode,
  createUserWithAuthIdentity,
  createDesktopSessionRecord,
  findUserPrincipalsByAuthIdentity,
  revokeDesktopSessionRecord,
  rotateDesktopSessionRecord,
  saveDesktopAuthorizationCode,
} from "@agent-hq/db";
import {
  createDesktopAuthorizationCodeBroker,
  createDesktopSessionService,
  desktopCorsHeaders,
  parseDesktopExchangeRequest,
  parseDesktopSessionRequest,
  type DesktopAuthorizationCodeStore,
  type DesktopSessionStore,
} from "@agent-hq/auth/server";

import { applicationDatabase } from "./database";

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
    ? configured
    : [
        ...PRODUCTION_DESKTOP_ORIGINS,
        ...(environment.NODE_ENV === "production" ? [] : [DEVELOPMENT_DESKTOP_ORIGIN]),
      ];
  if (
    origins.some(
      (origin) =>
        origin.includes("*") ||
        origin.includes("@") ||
        origin.endsWith("/") ||
        !/^(?:https?:\/\/|tauri:\/\/)[A-Za-z0-9.:[\]-]+$/u.test(origin),
    )
  ) {
    throw new Error("Desktop auth trusted origins are invalid");
  }
  return Object.freeze([...new Set(origins)]);
}

function codeStore(): DesktopAuthorizationCodeStore {
  return {
    consume: (codeDigest) => consumeDesktopAuthorizationCode(applicationDatabase(), codeDigest),
    save: (record) => saveDesktopAuthorizationCode(applicationDatabase(), record),
  };
}

function sessionStore(): DesktopSessionStore {
  return {
    create: (record) => createDesktopSessionRecord(applicationDatabase(), record),
    revoke: (input) => revokeDesktopSessionRecord(applicationDatabase(), input),
    rotate: (input) => rotateDesktopSessionRecord(applicationDatabase(), input),
  };
}

export function desktopSessionService() {
  return createDesktopSessionService({ store: sessionStore() });
}

export function desktopAuthorizationBroker() {
  const sessions = desktopSessionService();
  return createDesktopAuthorizationCodeBroker({
    issueSession: sessions.issue,
    store: codeStore(),
  });
}

export function desktopPrincipalMapping() {
  return {
    findUserPrincipals: (identity: Readonly<{ provider: string; subject: string }>) =>
      findUserPrincipalsByAuthIdentity(applicationDatabase(), identity),
    provision: (input: Parameters<typeof createUserWithAuthIdentity>[1]) =>
      createUserWithAuthIdentity(applicationDatabase(), input),
  };
}

export function desktopCorsPreflight(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  if (!desktopTrustedOrigins().includes(origin)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-headers": "Authorization, Content-Type, X-Agent-HQ-Desktop-Session",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      vary: "Origin",
    },
  });
}

export async function desktopExchangeResponse(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  const trustedOrigins = desktopTrustedOrigins();
  try {
    const exchange = await parseDesktopExchangeRequest(request, trustedOrigins);
    const session = await desktopAuthorizationBroker().exchange(exchange);
    return Response.json(session, { headers: desktopCorsHeaders(origin, trustedOrigins) });
  } catch {
    return Response.json(
      { error: "Desktop authorization exchange failed" },
      { headers: desktopCorsHeaders(origin, trustedOrigins), status: 400 },
    );
  }
}

export async function desktopSessionResponse(
  request: Request,
  action: "logout" | "refresh" | "revoke",
) {
  const origin = request.headers.get("origin") ?? "";
  const trustedOrigins = desktopTrustedOrigins();
  try {
    const credential = parseDesktopSessionRequest(request, trustedOrigins);
    const service = desktopSessionService();
    if (action === "refresh") {
      const session = await service.refresh(credential);
      return Response.json(session, { headers: desktopCorsHeaders(origin, trustedOrigins) });
    }
    await service[action](credential);
    return new Response(null, {
      headers: desktopCorsHeaders(origin, trustedOrigins),
      status: 204,
    });
  } catch {
    return Response.json(
      { error: "Desktop session is unavailable" },
      { headers: desktopCorsHeaders(origin, trustedOrigins), status: 401 },
    );
  }
}
