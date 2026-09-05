import {
  resolveAuthenticatedPrincipal,
  type AuthIdentityMapping,
  type AuthResult,
} from "@agent-hq/auth";

type DesktopPrincipalProvisioning = AuthIdentityMapping &
  Readonly<{
    provision(input: {
      identity: AuthResult["identity"];
      profile?: Readonly<{ displayName?: string }>;
    }): Promise<unknown>;
    setDisplayNameIfMissing(
      input: Readonly<{ displayName: string; userId: string }>
    ): Promise<void>;
  }>;

function accountLabel(authentication: AuthResult) {
  return (authentication.profile.displayName || authentication.profile.email)?.trim() || null;
}

export async function resolveOrProvisionDesktopPrincipal(
  authentication: AuthResult,
  provisioning: DesktopPrincipalProvisioning
) {
  const displayName = accountLabel(authentication);
  const existing = await resolveAuthenticatedPrincipal(authentication, provisioning);
  if (existing) {
    if (displayName) {
      await provisioning
        .setDisplayNameIfMissing({ displayName, userId: existing.userId })
        .catch(() => undefined);
    }
    return existing;
  }

  try {
    await provisioning.provision({
      identity: authentication.identity,
      ...(displayName
        ? {
            profile: {
              displayName,
            },
          }
        : {}),
    });
  } catch (error) {
    const concurrentWinner = await resolveAuthenticatedPrincipal(authentication, provisioning);
    if (concurrentWinner) {
      if (displayName) {
        await provisioning
          .setDisplayNameIfMissing({
            displayName,
            userId: concurrentWinner.userId,
          })
          .catch(() => undefined);
      }
      return concurrentWinner;
    }
    throw error;
  }
  return resolveAuthenticatedPrincipal(authentication, provisioning);
}
