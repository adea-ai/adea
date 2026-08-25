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
  }>;

export async function resolveOrProvisionDesktopPrincipal(
  authentication: AuthResult,
  provisioning: DesktopPrincipalProvisioning,
) {
  const existing = await resolveAuthenticatedPrincipal(authentication, provisioning);
  if (existing) return existing;

  try {
    await provisioning.provision({
      identity: authentication.identity,
      ...(authentication.profile.displayName
        ? { profile: { displayName: authentication.profile.displayName } }
        : {}),
    });
  } catch (error) {
    const concurrentWinner = await resolveAuthenticatedPrincipal(authentication, provisioning);
    if (concurrentWinner) return concurrentWinner;
    throw error;
  }
  return resolveAuthenticatedPrincipal(authentication, provisioning);
}
