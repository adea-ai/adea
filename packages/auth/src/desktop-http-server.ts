import { DESKTOP_CALLBACK_URI, type DesktopSessionExchangeInput } from "./desktop";
import type { DesktopSessionCredential } from "./desktop-server";

const BASE64_URL = /^[A-Za-z0-9_-]+$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUTHORIZATION_PARAMETERS = new Set([
  "client",
  "code_challenge",
  "code_challenge_method",
  "nonce",
  "redirect_uri",
  "response_type",
  "state",
]);
const MAX_EXCHANGE_BODY_BYTES = 4_096;

function bounded(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    BASE64_URL.test(value)
  );
}

function assertTrustedOrigin(request: Request, trustedOrigins: readonly string[]): string {
  const origin = request.headers.get("origin") ?? "";
  if (!trustedOrigins.includes(origin)) throw new Error("Desktop request origin is not trusted");
  return origin;
}

export function parseDesktopAuthorizationRequest(request: Request) {
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== AUTHORIZATION_PARAMETERS.size ||
    entries.some(([name]) => !AUTHORIZATION_PARAMETERS.has(name)) ||
    new Set(entries.map(([name]) => name)).size !== entries.length
  ) {
    throw new Error("Desktop authorization request is invalid");
  }

  const codeChallenge = url.searchParams.get("code_challenge");
  const nonce = url.searchParams.get("nonce");
  const state = url.searchParams.get("state");
  if (
    url.searchParams.get("client") !== "desktop" ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    url.searchParams.get("redirect_uri") !== DESKTOP_CALLBACK_URI ||
    url.searchParams.get("response_type") !== "code" ||
    !bounded(codeChallenge, 43, 128) ||
    !bounded(nonce, 16, 512) ||
    !bounded(state, 16, 512)
  ) {
    throw new Error("Desktop authorization request is invalid");
  }

  return Object.freeze({
    codeChallenge,
    nonce,
    redirectUri: DESKTOP_CALLBACK_URI,
    state,
  });
}

export async function parseDesktopExchangeRequest(
  request: Request,
  trustedOrigins: readonly string[]
): Promise<DesktopSessionExchangeInput> {
  assertTrustedOrigin(request, trustedOrigins);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new Error("Desktop exchange content type is invalid");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_EXCHANGE_BODY_BYTES) {
    throw new Error("Desktop exchange body is invalid");
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_EXCHANGE_BODY_BYTES) {
    throw new Error("Desktop exchange body is invalid");
  }

  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new Error("Desktop exchange body is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop exchange body is invalid");
  }
  const candidate = value as Partial<DesktopSessionExchangeInput> & Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 4 ||
    !bounded(candidate.code, 8, 512) ||
    !bounded(candidate.codeVerifier, 43, 128) ||
    !bounded(candidate.nonce, 16, 512) ||
    candidate.redirectUri !== DESKTOP_CALLBACK_URI
  ) {
    throw new Error("Desktop exchange body is invalid");
  }
  return Object.freeze({
    code: candidate.code,
    codeVerifier: candidate.codeVerifier,
    nonce: candidate.nonce,
    redirectUri: DESKTOP_CALLBACK_URI,
  });
}

export function parseDesktopSessionRequest(
  request: Request,
  trustedOrigins: readonly string[]
): DesktopSessionCredential {
  assertTrustedOrigin(request, trustedOrigins);
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, credential, extra] = authorization.split(" ");
  const sessionId = request.headers.get("x-agent-hq-desktop-session") ?? "";
  if (
    scheme !== "Desktop" ||
    extra !== undefined ||
    !bounded(credential, 32, 512) ||
    !SESSION_ID.test(sessionId)
  ) {
    throw new Error("Desktop session credential is invalid");
  }
  return Object.freeze({ credential, sessionId });
}

export function desktopCorsHeaders(origin: string, trustedOrigins: readonly string[]) {
  return Object.freeze({
    ...(trustedOrigins.includes(origin) ? { "access-control-allow-origin": origin } : {}),
    "cache-control": "no-store",
    vary: "Origin",
  });
}
