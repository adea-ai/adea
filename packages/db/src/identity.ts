import type { UserPrincipalRef } from "@agent-hq/types";
import { and, eq, isNull } from "drizzle-orm";

import type { AgentHqDatabase } from "./connection";
import { authIdentities, users } from "./schema";

export type AuthIdentityKey = Readonly<{
  provider: string;
  subject: string;
}>;

export type NewUserIdentity = Readonly<{
  identity: AuthIdentityKey;
  profile?: Readonly<{ displayName?: string }>;
}>;

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
