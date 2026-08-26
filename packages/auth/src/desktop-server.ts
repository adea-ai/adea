import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  DESKTOP_CALLBACK_URI,
  type DesktopSession,
  type DesktopSessionExchangeInput,
} from "./desktop";

const DEFAULT_CODE_TTL_MS = 60_000;

export type DesktopAuthorizationCodeRecord = Readonly<{
  codeChallenge: string;
  codeDigest: string;
  expiresAt: number;
  nonce: string;
  providerExpiresAt: number;
  providerSessionId: string;
  redirectUri: typeof DESKTOP_CALLBACK_URI;
  userId: string;
}>;

export interface DesktopAuthorizationCodeStore {
  /** Atomically returns and deletes a code record. */
  consume(codeDigest: string): Promise<DesktopAuthorizationCodeRecord | null>;
  save(record: DesktopAuthorizationCodeRecord): Promise<void>;
}

export type DesktopAuthorizationCodeIssue = Readonly<{
  codeChallenge: string;
  nonce: string;
  providerExpiresAt: number;
  providerSessionId: string;
  redirectUri: typeof DESKTOP_CALLBACK_URI;
  state: string;
  userId: string;
}>;

export type DesktopSessionRecord = Readonly<{
  credentialDigest: string;
  expiresAt: number;
  providerExpiresAt: number;
  providerSessionId: string;
  revokedAt: number | null;
  sessionId: string;
  userId: string;
}>;

export interface DesktopSessionStore {
  create(record: DesktopSessionRecord): Promise<void>;
  revoke(input: Readonly<{ credentialDigest: string; sessionId: string }>): Promise<boolean>;
  resolve(
    input: Readonly<{ credentialDigest: string; now: number; sessionId: string }>,
  ): Promise<DesktopSessionRecord | null>;
  rotate(
    input: Readonly<{
      credentialDigest: string;
      expiresAt: number;
      nextCredentialDigest: string;
      now: number;
      sessionId: string;
    }>,
  ): Promise<DesktopSessionRecord | null>;
}

export type DesktopSessionPrincipal = Readonly<{
  providerExpiresAt: number;
  providerSessionId: string;
  userId: string;
}>;

export type DesktopSessionCredential = Readonly<Pick<DesktopSession, "credential" | "sessionId">>;

function digest(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function matches(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertBounded(value: string, name: string, minimum = 16, maximum = 512) {
  if (value.length < minimum || value.length > maximum) {
    throw new Error(`Desktop authorization ${name} is invalid`);
  }
}

export function createDesktopAuthorizationCodeBroker({
  issueSession,
  now = Date.now,
  store,
  ttlMs = DEFAULT_CODE_TTL_MS,
}: {
  issueSession(principal: DesktopSessionPrincipal): Promise<DesktopSession>;
  now?: () => number;
  store: DesktopAuthorizationCodeStore;
  ttlMs?: number;
}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_CODE_TTL_MS) {
    throw new Error("Desktop authorization code TTL is invalid");
  }

  return {
    async exchange(input: DesktopSessionExchangeInput): Promise<DesktopSession> {
      assertBounded(input.code, "code", 8);
      assertBounded(input.codeVerifier, "PKCE verifier", 43, 128);
      assertBounded(input.nonce, "nonce");
      if (input.redirectUri !== DESKTOP_CALLBACK_URI) {
        throw new Error("Desktop authorization redirect is not trusted");
      }

      const record = await store.consume(digest(input.code));
      if (!record) throw new Error("Desktop authorization code is unavailable");
      if (record.expiresAt <= now()) throw new Error("Desktop authorization code expired");
      if (record.redirectUri !== input.redirectUri) {
        throw new Error("Desktop authorization redirect mismatch");
      }
      if (!matches(record.nonce, input.nonce)) {
        throw new Error("Desktop authorization nonce mismatch");
      }
      if (!matches(record.codeChallenge, digest(input.codeVerifier))) {
        throw new Error("Desktop authorization PKCE verifier mismatch");
      }

      return issueSession({
        providerExpiresAt: record.providerExpiresAt,
        providerSessionId: record.providerSessionId,
        userId: record.userId,
      });
    },
    async issue(input: DesktopAuthorizationCodeIssue): Promise<string> {
      if (input.redirectUri !== DESKTOP_CALLBACK_URI) {
        throw new Error("Desktop authorization redirect is not trusted");
      }
      assertBounded(input.codeChallenge, "PKCE challenge", 43, 128);
      assertBounded(input.nonce, "nonce");
      assertBounded(input.providerSessionId, "provider session ID", 1);
      assertBounded(input.state, "state");
      assertBounded(input.userId, "user ID", 1);
      if (!Number.isFinite(input.providerExpiresAt) || input.providerExpiresAt <= now()) {
        throw new Error("Desktop authorization provider session expired");
      }

      const code = randomBytes(32).toString("base64url");
      await store.save({
        codeChallenge: input.codeChallenge,
        codeDigest: digest(code),
        expiresAt: now() + ttlMs,
        nonce: input.nonce,
        providerExpiresAt: input.providerExpiresAt,
        providerSessionId: input.providerSessionId,
        redirectUri: DESKTOP_CALLBACK_URI,
        userId: input.userId,
      });

      const callback = new URL(DESKTOP_CALLBACK_URI);
      callback.searchParams.set("code", code);
      callback.searchParams.set("nonce", input.nonce);
      callback.searchParams.set("state", input.state);
      return callback.toString();
    },
  };
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

function toDesktopSession(record: DesktopSessionRecord, credential: string): DesktopSession {
  return Object.freeze({
    credential,
    expiresAt: new Date(record.expiresAt).toISOString(),
    sessionId: record.sessionId,
  });
}

function assertDesktopSession(session: DesktopSessionCredential) {
  assertBounded(session.credential, "session credential", 32);
  assertBounded(session.sessionId, "session ID", 16);
}

export function createDesktopSessionService({
  now = Date.now,
  store,
  ttlMs = DEFAULT_SESSION_TTL_MS,
}: {
  now?: () => number;
  store: DesktopSessionStore;
  ttlMs?: number;
}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SESSION_TTL_MS) {
    throw new Error("Desktop session TTL is invalid");
  }

  return {
    async issue(principal: DesktopSessionPrincipal): Promise<DesktopSession> {
      const issuedAt = now();
      assertBounded(principal.providerSessionId, "provider session ID", 1);
      assertBounded(principal.userId, "user ID", 1);
      if (
        !Number.isFinite(principal.providerExpiresAt) ||
        principal.providerExpiresAt <= issuedAt
      ) {
        throw new Error("Desktop provider session expired");
      }

      const credential = randomBytes(32).toString("base64url");
      const record: DesktopSessionRecord = Object.freeze({
        credentialDigest: digest(credential),
        expiresAt: issuedAt + ttlMs,
        providerExpiresAt: principal.providerExpiresAt,
        providerSessionId: principal.providerSessionId,
        revokedAt: null,
        sessionId: randomUUID(),
        userId: principal.userId,
      });
      await store.create(record);
      return toDesktopSession(record, credential);
    },
    async logout(session: DesktopSessionCredential): Promise<void> {
      assertDesktopSession(session);
      const revoked = await store.revoke({
        credentialDigest: digest(session.credential),
        sessionId: session.sessionId,
      });
      if (!revoked) throw new Error("Desktop session is unavailable");
    },
    async refresh(session: DesktopSessionCredential): Promise<DesktopSession> {
      assertDesktopSession(session);
      const refreshedAt = now();
      const credential = randomBytes(32).toString("base64url");
      const record = await store.rotate({
        credentialDigest: digest(session.credential),
        expiresAt: refreshedAt + ttlMs,
        nextCredentialDigest: digest(credential),
        now: refreshedAt,
        sessionId: session.sessionId,
      });
      if (!record) throw new Error("Desktop session is unavailable");
      return toDesktopSession(record, credential);
    },
    async resolve(session: DesktopSessionCredential): Promise<DesktopSessionPrincipal | null> {
      assertDesktopSession(session);
      const record = await store.resolve({
        credentialDigest: digest(session.credential),
        now: now(),
        sessionId: session.sessionId,
      });
      return record
        ? Object.freeze({
            providerExpiresAt: record.providerExpiresAt,
            providerSessionId: record.providerSessionId,
            userId: record.userId,
          })
        : null;
    },
    async revoke(session: DesktopSessionCredential): Promise<void> {
      assertDesktopSession(session);
      const revoked = await store.revoke({
        credentialDigest: digest(session.credential),
        sessionId: session.sessionId,
      });
      if (!revoked) throw new Error("Desktop session is unavailable");
    },
  };
}
