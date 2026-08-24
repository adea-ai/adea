import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDatabase, type DatabaseConnection } from "../../../db/src/connection";
import {
  consumeDesktopAuthorizationCode,
  createDesktopSessionRecord,
  revokeDesktopSessionRecord,
  rotateDesktopSessionRecord,
  saveDesktopAuthorizationCode,
} from "../../../db/src/desktop-auth";
import { createUserWithAuthIdentity } from "../../../db/src/identity";

import { createDesktopAuthorizationAttempt } from "../../src/desktop";
import {
  createDesktopAuthorizationCodeBroker,
  createDesktopSessionService,
} from "../../src/desktop-server";
const connectionUrl = process.env.DATABASE_URL;

describe.skipIf(!connectionUrl)("desktop authorization with PostgreSQL", () => {
  let connection: DatabaseConnection;

  beforeAll(() => {
    connection = createDatabase(connectionUrl!);
  });

  afterAll(async () => {
    await connection.close();
  });

  test("exchanges one PKCE code, rotates the credential, and revokes the session", async () => {
    const principal = await createUserWithAuthIdentity(connection.db, {
      identity: { provider: "neon", subject: `desktop-flow-${crypto.randomUUID()}` },
    });
    const now = Date.now();
    const sessions = createDesktopSessionService({
      now: () => now,
      store: {
        create: (record) => createDesktopSessionRecord(connection.db, record),
        revoke: (input) => revokeDesktopSessionRecord(connection.db, input),
        rotate: (input) => rotateDesktopSessionRecord(connection.db, input),
      },
    });
    const broker = createDesktopAuthorizationCodeBroker({
      issueSession: sessions.issue,
      now: () => now,
      store: {
        consume: (digest) => consumeDesktopAuthorizationCode(connection.db, digest),
        save: (record) => saveDesktopAuthorizationCode(connection.db, record),
      },
    });
    const attempt = await createDesktopAuthorizationAttempt({ now });
    const callback = new URL(
      await broker.issue({
        codeChallenge: attempt.codeChallenge,
        nonce: attempt.nonce,
        providerExpiresAt: now + 3_600_000,
        providerSessionId: "provider-session-1",
        redirectUri: attempt.redirectUri,
        state: attempt.state,
        userId: principal.userId,
      }),
    );
    const exchange = {
      code: callback.searchParams.get("code")!,
      codeVerifier: attempt.codeVerifier,
      nonce: attempt.nonce,
      redirectUri: attempt.redirectUri,
    };

    const session = await broker.exchange(exchange);
    await expect(broker.exchange(exchange)).rejects.toThrow("unavailable");
    const refreshed = await sessions.refresh(session);
    expect(refreshed.credential).not.toBe(session.credential);
    await sessions.revoke(refreshed);
    await expect(sessions.refresh(refreshed)).rejects.toThrow("unavailable");

    await connection.client`DELETE FROM app.users WHERE id = ${principal.userId}`;
  });
});
