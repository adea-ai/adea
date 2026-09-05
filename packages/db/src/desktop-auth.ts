import { and, eq, gt, isNull } from "drizzle-orm";

import type { AgentHqDatabase } from "./connection";
import { desktopAuthorizationCodes, desktopSessions, users } from "./schema";

export type StoredDesktopAuthorizationCode = Readonly<{
  codeChallenge: string;
  codeDigest: string;
  expiresAt: number;
  nonce: string;
  providerExpiresAt: number;
  providerSessionId: string;
  redirectUri: "agent-hq://auth/callback";
  userId: string;
}>;

export type StoredDesktopSession = Readonly<{
  credentialDigest: string;
  expiresAt: number;
  providerExpiresAt: number;
  providerSessionId: string;
  revokedAt: number | null;
  sessionId: string;
  userId: string;
}>;

function authorizationCodeFromRow(
  row: typeof desktopAuthorizationCodes.$inferSelect
): StoredDesktopAuthorizationCode {
  if (row.redirectUri !== "agent-hq://auth/callback") {
    throw new Error("Stored desktop authorization redirect is invalid");
  }
  return Object.freeze({
    codeChallenge: row.codeChallenge,
    codeDigest: row.codeDigest,
    expiresAt: row.expiresAt.valueOf(),
    nonce: row.nonce,
    providerExpiresAt: row.providerExpiresAt.valueOf(),
    providerSessionId: row.providerSessionId,
    redirectUri: row.redirectUri,
    userId: row.userId,
  });
}

function sessionFromRow(row: typeof desktopSessions.$inferSelect): StoredDesktopSession {
  return Object.freeze({
    credentialDigest: row.credentialDigest,
    expiresAt: row.expiresAt.valueOf(),
    providerExpiresAt: row.providerExpiresAt.valueOf(),
    providerSessionId: row.providerSessionId,
    revokedAt: row.revokedAt?.valueOf() ?? null,
    sessionId: row.sessionId,
    userId: row.userId,
  });
}

export async function saveDesktopAuthorizationCode(
  database: AgentHqDatabase,
  record: StoredDesktopAuthorizationCode
): Promise<void> {
  await database.insert(desktopAuthorizationCodes).values({
    ...record,
    expiresAt: new Date(record.expiresAt),
    providerExpiresAt: new Date(record.providerExpiresAt),
  });
}

export async function consumeDesktopAuthorizationCode(
  database: AgentHqDatabase,
  codeDigest: string
): Promise<StoredDesktopAuthorizationCode | null> {
  const [row] = await database
    .delete(desktopAuthorizationCodes)
    .where(eq(desktopAuthorizationCodes.codeDigest, codeDigest))
    .returning();
  return row ? authorizationCodeFromRow(row) : null;
}

export async function createDesktopSessionRecord(
  database: AgentHqDatabase,
  record: StoredDesktopSession
): Promise<void> {
  await database.insert(desktopSessions).values({
    credentialDigest: record.credentialDigest,
    expiresAt: new Date(record.expiresAt),
    providerExpiresAt: new Date(record.providerExpiresAt),
    providerSessionId: record.providerSessionId,
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
    sessionId: record.sessionId,
    userId: record.userId,
  });
}

export async function rotateDesktopSessionRecord(
  database: AgentHqDatabase,
  input: Readonly<{
    credentialDigest: string;
    expiresAt: number;
    nextCredentialDigest: string;
    now: number;
    sessionId: string;
  }>
): Promise<StoredDesktopSession | null> {
  const now = new Date(input.now);
  const [row] = await database
    .update(desktopSessions)
    .set({
      credentialDigest: input.nextCredentialDigest,
      expiresAt: new Date(input.expiresAt),
      updatedAt: now,
    })
    .where(
      and(
        eq(desktopSessions.sessionId, input.sessionId),
        eq(desktopSessions.credentialDigest, input.credentialDigest),
        isNull(desktopSessions.revokedAt),
        gt(desktopSessions.expiresAt, now)
      )
    )
    .returning();
  return row ? sessionFromRow(row) : null;
}

export async function resolveDesktopSessionRecord(
  database: AgentHqDatabase,
  input: Readonly<{ credentialDigest: string; now: number; sessionId: string }>
): Promise<StoredDesktopSession | null> {
  const now = new Date(input.now);
  const [row] = await database
    .select({ session: desktopSessions })
    .from(desktopSessions)
    .innerJoin(users, eq(desktopSessions.userId, users.id))
    .where(
      and(
        eq(desktopSessions.sessionId, input.sessionId),
        eq(desktopSessions.credentialDigest, input.credentialDigest),
        isNull(desktopSessions.revokedAt),
        gt(desktopSessions.expiresAt, now),
        eq(users.isTemporary, false),
        isNull(users.disabledAt)
      )
    )
    .limit(1);
  return row ? sessionFromRow(row.session) : null;
}

export async function revokeDesktopSessionRecord(
  database: AgentHqDatabase,
  input: Readonly<{ credentialDigest: string; sessionId: string }>
): Promise<boolean> {
  const [row] = await database
    .update(desktopSessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(desktopSessions.sessionId, input.sessionId),
        eq(desktopSessions.credentialDigest, input.credentialDigest),
        isNull(desktopSessions.revokedAt)
      )
    )
    .returning({ sessionId: desktopSessions.sessionId });
  return Boolean(row);
}
