import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { normalizeTrustedTarget } from "./config";

export type AuthorizationTransaction = {
  codeChallenge: string;
  codeVerifier: string;
  expiresAt: number;
  nonce: string;
  redirectUri: string;
  state: string;
  used: boolean;
};

function randomUrlSafe(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function matches(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function assertTrustedOrigin(
  candidate: string | undefined,
  trustedOrigins: readonly string[],
): string {
  if (!candidate) throw new Error("Auth request origin is required");
  const normalized = normalizeTrustedTarget(candidate);
  if (!trustedOrigins.includes(normalized)) {
    throw new Error("Auth request origin is not trusted");
  }
  return normalized;
}

export async function createAuthorizationState({
  redirectUri,
  trustedOrigins,
  ttlMs = 5 * 60 * 1_000,
}: {
  redirectUri: string;
  trustedOrigins: readonly string[];
  ttlMs?: number;
}): Promise<AuthorizationTransaction> {
  const normalizedRedirect = assertTrustedOrigin(redirectUri, trustedOrigins);
  const codeVerifier = randomUrlSafe(48);
  return {
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    codeVerifier,
    expiresAt: Date.now() + ttlMs,
    nonce: randomUrlSafe(),
    redirectUri: normalizedRedirect,
    state: randomUrlSafe(),
    used: false,
  };
}

export async function verifyAuthorizationState(
  transaction: AuthorizationTransaction,
  callback: { nonce: string; redirectUri: string; state: string },
): Promise<true> {
  if (transaction.used) throw new Error("Authorization state was already consumed");
  if (transaction.expiresAt <= Date.now()) throw new Error("Authorization state expired");
  if (!matches(transaction.state, callback.state)) throw new Error("Authorization state mismatch");
  if (!matches(transaction.nonce, callback.nonce)) throw new Error("Authorization nonce mismatch");
  if (!matches(transaction.redirectUri, normalizeTrustedTarget(callback.redirectUri))) {
    throw new Error("Authorization redirect mismatch");
  }
  transaction.used = true;
  return true;
}
