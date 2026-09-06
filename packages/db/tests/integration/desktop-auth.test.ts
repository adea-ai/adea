import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseConnection } from "../../src/connection";
import {
  consumeDesktopAuthorizationCode,
  createDesktopSessionRecord,
  revokeDesktopSessionRecord,
  rotateDesktopSessionRecord,
  saveDesktopAuthorizationCode,
} from "../../src/desktop-auth";
import { createUserWithAuthIdentity } from "../../src/identity";
import { users } from "../../src/schema";

const connectionUrl = process.env.DATABASE_URL;

describe.skipIf(!connectionUrl)("desktop auth persistence", () => {
  let connection: DatabaseConnection;

  beforeAll(() => {
    connection = createDatabase(connectionUrl!);
  });

  afterAll(async () => {
    await connection.close();
  });

  test("consumes one-time codes atomically and rotates application sessions", async () => {
    const principal = await createUserWithAuthIdentity(connection.db, {
      identity: { provider: "neon", subject: `desktop-${crypto.randomUUID()}` },
    });
    const now = Date.now();
    const code = {
      codeChallenge: "challenge",
      codeDigest: crypto.randomUUID(),
      expiresAt: now + 60_000,
      nonce: "nonce",
      providerExpiresAt: now + 3_600_000,
      providerSessionId: "provider-session",
      redirectUri: "adea://auth/callback" as const,
      userId: principal.userId,
    };
    await saveDesktopAuthorizationCode(connection.db, code);
    expect(await consumeDesktopAuthorizationCode(connection.db, code.codeDigest)).toEqual(code);
    expect(await consumeDesktopAuthorizationCode(connection.db, code.codeDigest)).toBeNull();

    const session = {
      credentialDigest: crypto.randomUUID(),
      expiresAt: now + 900_000,
      providerExpiresAt: now - 1_000,
      providerSessionId: "provider-session",
      revokedAt: null,
      sessionId: crypto.randomUUID(),
      userId: principal.userId,
    };
    await createDesktopSessionRecord(connection.db, session);
    const nextDigest = crypto.randomUUID();
    expect(
      await rotateDesktopSessionRecord(connection.db, {
        credentialDigest: session.credentialDigest,
        expiresAt: now + 1_000_000,
        nextCredentialDigest: nextDigest,
        now,
        sessionId: session.sessionId,
      })
    ).toMatchObject({ credentialDigest: nextDigest, sessionId: session.sessionId });
    expect(
      await rotateDesktopSessionRecord(connection.db, {
        credentialDigest: session.credentialDigest,
        expiresAt: now + 1_000_000,
        nextCredentialDigest: crypto.randomUUID(),
        now,
        sessionId: session.sessionId,
      })
    ).toBeNull();
    expect(
      await revokeDesktopSessionRecord(connection.db, {
        credentialDigest: nextDigest,
        sessionId: session.sessionId,
      })
    ).toBe(true);
    expect(
      await rotateDesktopSessionRecord(connection.db, {
        credentialDigest: nextDigest,
        expiresAt: now + 1_000_000,
        nextCredentialDigest: crypto.randomUUID(),
        now,
        sessionId: session.sessionId,
      })
    ).toBeNull();

    await connection.db.delete(users).where(eq(users.id, principal.userId));
  });
});
