import type { UserPrincipalRef } from "@agent-hq/types";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { AgentHqDatabase } from "./connection";
import {
  authIdentities,
  temporaryUserSessions,
  users,
  workspaceMemberships,
  workspaces,
} from "./schema";

export type AuthIdentityKey = Readonly<{
  provider: string;
  subject: string;
}>;

export type NewUserIdentity = Readonly<{
  identity: AuthIdentityKey;
  profile?: Readonly<{ displayName?: string }>;
}>;

export async function getUserDisplayName(
  database: AgentHqDatabase,
  principal: UserPrincipalRef,
): Promise<string | null> {
  const [user] = await database
    .select({ displayName: users.displayName })
    .from(users)
    .where(and(eq(users.id, principal.userId), isNull(users.disabledAt)))
    .limit(1);
  return user?.displayName ?? null;
}

export async function setUserDisplayNameIfMissing(
  database: AgentHqDatabase,
  input: Readonly<{ displayName: string; userId: string }>,
): Promise<void> {
  await database
    .update(users)
    .set({ displayName: input.displayName })
    .where(and(eq(users.id, input.userId), isNull(users.displayName), isNull(users.disabledAt)));
}

export async function createUserWithAuthIdentity(
  database: AgentHqDatabase,
  input: NewUserIdentity,
): Promise<UserPrincipalRef> {
  return database.transaction(async (transaction) => {
    const [user] = await transaction
      .insert(users)
      .values({ displayName: input.profile?.displayName })
      .returning({ id: users.id });
    if (!user) throw new Error("Stable user creation failed");

    await transaction.insert(authIdentities).values({
      provider: input.identity.provider,
      subject: input.identity.subject,
      userId: user.id,
    });

    return Object.freeze({ kind: "user" as const, userId: user.id });
  });
}

export type TemporaryUserSessionInput = Readonly<{
  credentialDigest: string;
  expiresAt: Date;
  displayName?: string;
}>;

export type TemporaryUserSessionRecord = Readonly<{
  expiresAt: string;
  principal: UserPrincipalRef;
  sessionId: string;
}>;

export async function createTemporaryUserSession(
  database: AgentHqDatabase,
  input: TemporaryUserSessionInput,
): Promise<TemporaryUserSessionRecord> {
  return database.transaction(async (transaction) => {
    const [user] = await transaction
      .insert(users)
      .values({ displayName: input.displayName, isTemporary: true })
      .returning({ id: users.id });
    if (!user) throw new Error("Temporary user creation failed");

    const [session] = await transaction
      .insert(temporaryUserSessions)
      .values({
        credentialDigest: input.credentialDigest,
        expiresAt: input.expiresAt,
        userId: user.id,
      })
      .returning({ id: temporaryUserSessions.id });
    if (!session) throw new Error("Temporary session creation failed");

    return Object.freeze({
      expiresAt: input.expiresAt.toISOString(),
      principal: Object.freeze({ kind: "user" as const, userId: user.id }),
      sessionId: session.id,
    });
  });
}

export async function resolveTemporaryUserSession(
  database: AgentHqDatabase,
  credentialDigest: string,
  now = new Date(),
): Promise<UserPrincipalRef | null> {
  const [match] = await database
    .select({ userId: users.id })
    .from(temporaryUserSessions)
    .innerJoin(users, eq(temporaryUserSessions.userId, users.id))
    .where(
      and(
        eq(temporaryUserSessions.credentialDigest, credentialDigest),
        gt(temporaryUserSessions.expiresAt, now),
        isNull(temporaryUserSessions.claimedAt),
        eq(users.isTemporary, true),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);

  return match ? Object.freeze({ kind: "user" as const, userId: match.userId }) : null;
}

export async function claimTemporaryUserSession(
  database: AgentHqDatabase,
  input: Readonly<{
    credentialDigest: string;
    identity: AuthIdentityKey;
    profile?: Readonly<{ displayName?: string }>;
  }>,
): Promise<UserPrincipalRef> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${input.identity.provider}:${input.identity.subject}`}))`,
    );
    const [existingIdentity] = await transaction
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .innerJoin(users, eq(authIdentities.userId, users.id))
      .where(
        and(
          eq(authIdentities.provider, input.identity.provider),
          eq(authIdentities.subject, input.identity.subject),
          isNull(authIdentities.revokedAt),
          isNull(users.disabledAt),
        ),
      )
      .limit(1);

    const [temporarySession] = await transaction
      .select({
        claimedAt: temporaryUserSessions.claimedAt,
        claimedByUserId: temporaryUserSessions.claimedByUserId,
        userId: temporaryUserSessions.userId,
      })
      .from(temporaryUserSessions)
      .where(
        and(
          eq(temporaryUserSessions.credentialDigest, input.credentialDigest),
          gt(temporaryUserSessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for("update");
    if (!temporarySession) throw new Error("Temporary workspace unavailable");
    if (temporarySession.claimedAt) {
      if (existingIdentity?.userId === temporarySession.claimedByUserId) {
        return Object.freeze({ kind: "user" as const, userId: existingIdentity.userId });
      }
      throw new Error("Temporary workspace unavailable");
    }

    const [temporary] = await transaction
      .select({ userId: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, temporarySession.userId),
          eq(users.isTemporary, true),
          isNull(users.disabledAt),
        ),
      )
      .limit(1);
    if (!temporary) throw new Error("Temporary workspace unavailable");

    const now = new Date();
    if (!existingIdentity) {
      await transaction.insert(authIdentities).values({
        provider: input.identity.provider,
        subject: input.identity.subject,
        userId: temporary.userId,
      });
      await transaction
        .update(users)
        .set({ displayName: input.profile?.displayName, isTemporary: false, updatedAt: now })
        .where(eq(users.id, temporary.userId));
      await transaction
        .update(temporaryUserSessions)
        .set({ claimedAt: now, claimedByUserId: temporary.userId, updatedAt: now })
        .where(eq(temporaryUserSessions.userId, temporary.userId));
      return Object.freeze({ kind: "user" as const, userId: temporary.userId });
    }

    const targetUserId = existingIdentity.userId;
    const memberships = await transaction
      .select({ role: workspaceMemberships.role, workspaceId: workspaceMemberships.workspaceId })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, temporary.userId));
    const rolePriority = { member: 1, admin: 2, owner: 3 } as const;

    for (const membership of memberships) {
      const [workspace] = await transaction
        .select({ ownerUserId: workspaces.ownerUserId })
        .from(workspaces)
        .where(eq(workspaces.id, membership.workspaceId))
        .limit(1);
      const transferredRole =
        workspace?.ownerUserId === temporary.userId ? "owner" : membership.role;
      const [targetMembership] = await transaction
        .select({ id: workspaceMemberships.id, role: workspaceMemberships.role })
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, membership.workspaceId),
            eq(workspaceMemberships.userId, targetUserId),
          ),
        )
        .limit(1);

      if (!targetMembership) {
        await transaction.insert(workspaceMemberships).values({
          role: transferredRole,
          userId: targetUserId,
          workspaceId: membership.workspaceId,
        });
      } else if (rolePriority[transferredRole] > rolePriority[targetMembership.role]) {
        await transaction
          .update(workspaceMemberships)
          .set({ role: transferredRole, updatedAt: now })
          .where(eq(workspaceMemberships.id, targetMembership.id));
      }

      if (workspace?.ownerUserId === temporary.userId) {
        await transaction
          .update(workspaces)
          .set({
            idempotencyKey: `claimed:${membership.workspaceId}`,
            ownerUserId: targetUserId,
            updatedAt: now,
          })
          .where(eq(workspaces.id, membership.workspaceId));
      }
      await transaction
        .delete(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, membership.workspaceId),
            eq(workspaceMemberships.userId, temporary.userId),
          ),
        );
    }

    await transaction
      .update(temporaryUserSessions)
      .set({ claimedAt: now, claimedByUserId: targetUserId, updatedAt: now })
      .where(eq(temporaryUserSessions.userId, temporary.userId));
    await transaction
      .update(users)
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(users.id, temporary.userId));
    return Object.freeze({ kind: "user" as const, userId: targetUserId });
  });
}

export async function claimTemporaryUserSessionForUser(
  database: AgentHqDatabase,
  input: Readonly<{ credentialDigest: string; target: UserPrincipalRef }>,
): Promise<UserPrincipalRef> {
  return database.transaction(async (transaction) => {
    const [target] = await transaction
      .select({ userId: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, input.target.userId),
          eq(users.isTemporary, false),
          isNull(users.disabledAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!target) throw new Error("Target user unavailable");

    const [temporarySession] = await transaction
      .select({
        claimedAt: temporaryUserSessions.claimedAt,
        claimedByUserId: temporaryUserSessions.claimedByUserId,
        userId: temporaryUserSessions.userId,
      })
      .from(temporaryUserSessions)
      .where(
        and(
          eq(temporaryUserSessions.credentialDigest, input.credentialDigest),
          gt(temporaryUserSessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for("update");
    if (!temporarySession) throw new Error("Temporary workspace unavailable");
    if (temporarySession.claimedAt) {
      if (temporarySession.claimedByUserId === target.userId) {
        return Object.freeze({ kind: "user" as const, userId: target.userId });
      }
      throw new Error("Temporary workspace unavailable");
    }

    const [temporary] = await transaction
      .select({ userId: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, temporarySession.userId),
          eq(users.isTemporary, true),
          isNull(users.disabledAt),
        ),
      )
      .limit(1);
    if (!temporary) throw new Error("Temporary workspace unavailable");

    const now = new Date();
    const memberships = await transaction
      .select({ role: workspaceMemberships.role, workspaceId: workspaceMemberships.workspaceId })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, temporary.userId));
    const rolePriority = { member: 1, admin: 2, owner: 3 } as const;

    for (const membership of memberships) {
      const [workspace] = await transaction
        .select({ ownerUserId: workspaces.ownerUserId })
        .from(workspaces)
        .where(eq(workspaces.id, membership.workspaceId))
        .limit(1);
      const transferredRole =
        workspace?.ownerUserId === temporary.userId ? "owner" : membership.role;
      const [targetMembership] = await transaction
        .select({ id: workspaceMemberships.id, role: workspaceMemberships.role })
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, membership.workspaceId),
            eq(workspaceMemberships.userId, target.userId),
          ),
        )
        .limit(1);

      if (!targetMembership) {
        await transaction.insert(workspaceMemberships).values({
          role: transferredRole,
          userId: target.userId,
          workspaceId: membership.workspaceId,
        });
      } else if (rolePriority[transferredRole] > rolePriority[targetMembership.role]) {
        await transaction
          .update(workspaceMemberships)
          .set({ role: transferredRole, updatedAt: now })
          .where(eq(workspaceMemberships.id, targetMembership.id));
      }

      if (workspace?.ownerUserId === temporary.userId) {
        await transaction
          .update(workspaces)
          .set({
            idempotencyKey: `claimed:${membership.workspaceId}`,
            ownerUserId: target.userId,
            updatedAt: now,
          })
          .where(eq(workspaces.id, membership.workspaceId));
      }
      await transaction
        .delete(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, membership.workspaceId),
            eq(workspaceMemberships.userId, temporary.userId),
          ),
        );
    }

    await transaction
      .update(temporaryUserSessions)
      .set({ claimedAt: now, claimedByUserId: target.userId, updatedAt: now })
      .where(eq(temporaryUserSessions.userId, temporary.userId));
    await transaction
      .update(users)
      .set({ disabledAt: now, updatedAt: now })
      .where(eq(users.id, temporary.userId));
    return Object.freeze({ kind: "user" as const, userId: target.userId });
  });
}

export async function findUserPrincipalsByAuthIdentity(
  database: AgentHqDatabase,
  identity: AuthIdentityKey,
): Promise<UserPrincipalRef[]> {
  const matches = await database
    .select({ userId: users.id })
    .from(authIdentities)
    .innerJoin(users, eq(authIdentities.userId, users.id))
    .where(
      and(
        eq(authIdentities.provider, identity.provider),
        eq(authIdentities.subject, identity.subject),
        isNull(authIdentities.revokedAt),
        isNull(users.disabledAt),
      ),
    )
    .limit(2);

  return matches.map(({ userId }) => Object.freeze({ kind: "user" as const, userId }));
}

export async function revokeAuthIdentity(
  database: AgentHqDatabase,
  identity: AuthIdentityKey,
): Promise<boolean> {
  const revoked = await database
    .update(authIdentities)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(authIdentities.provider, identity.provider),
        eq(authIdentities.subject, identity.subject),
        isNull(authIdentities.revokedAt),
      ),
    )
    .returning({ id: authIdentities.id });
  return revoked.length === 1;
}
