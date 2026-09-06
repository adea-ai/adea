import { isUserPrincipalRef, type PrincipalRef, type UserPrincipalRef } from "@adea/types";

import type { AuthResult } from "./session";

export interface AuthIdentityMapping {
  findUserPrincipals(identity: AuthResult["identity"]): Promise<readonly PrincipalRef[]>;
}

export async function resolveAuthenticatedPrincipal(
  authentication: AuthResult | null,
  mapping: AuthIdentityMapping
): Promise<UserPrincipalRef | null> {
  if (!authentication) return null;

  try {
    const principals = await mapping.findUserPrincipals(authentication.identity);
    if (principals.length !== 1 || !isUserPrincipalRef(principals[0])) return null;
    return principals[0];
  } catch {
    return null;
  }
}
