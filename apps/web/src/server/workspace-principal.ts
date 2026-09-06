import "server-only";

import type { AuthResult } from "@adea/auth";
import { createNeonServerAdapter } from "@adea/auth/server";
import {
  claimTemporaryUserSession,
  createTemporaryUserSession,
  resolveTemporaryUserSession,
} from "@adea/db";
import type { UserPrincipalRef } from "@adea/types";

import { applicationDatabase } from "./database";
import { desktopPrincipalMapping, resolveDesktopSessionPrincipal } from "./desktop-auth";
import { resolveOrProvisionDesktopPrincipal } from "./desktop-principal";
import {
  createTemporaryCredential,
  digestTemporaryCredential,
  readTemporaryCredential,
} from "./temporary-session";

const TEMPORARY_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

export type WorkspacePrincipalResolution = Readonly<{
  clearTemporaryCredential: boolean;
  createdCredential?: string;
  expiresAt?: Date;
  principal: UserPrincipalRef;
  sessionRotated: boolean;
  temporary: boolean;
}>;

export async function resolveWorkspacePrincipal(
  request: Request,
  options: Readonly<{ createTemporary?: boolean }> = {}
): Promise<WorkspacePrincipalResolution | null> {
  const database = applicationDatabase();
  if (request.headers.get("authorization")?.startsWith("Desktop ")) {
    try {
      const principal = await resolveDesktopSessionPrincipal(request);
      return principal
        ? Object.freeze({
            clearTemporaryCredential: false,
            principal,
            sessionRotated: false,
            temporary: false,
          })
        : null;
    } catch {
      return null;
    }
  }
  const credential = readTemporaryCredential(request);
  let authentication: AuthResult | null = null;
  try {
    authentication = await createNeonServerAdapter().getSession();
  } catch {
    // Account persistence is optional. A missing provider configuration must not block guests.
  }

  if (authentication) {
    if (credential) {
      try {
        const principal = await claimTemporaryUserSession(database, {
          credentialDigest: await digestTemporaryCredential(credential),
          identity: authentication.identity,
          ...(authentication.profile.displayName
            ? { profile: { displayName: authentication.profile.displayName } }
            : {}),
        });
        return Object.freeze({
          clearTemporaryCredential: true,
          principal,
          sessionRotated: false,
          temporary: false,
        });
      } catch {
        // A claimed, expired, or foreign temporary credential must not block a valid account.
      }
    }

    const principal = await resolveOrProvisionDesktopPrincipal(
      authentication,
      desktopPrincipalMapping()
    );
    return principal
      ? Object.freeze({
          clearTemporaryCredential: Boolean(credential),
          principal,
          sessionRotated: false,
          temporary: false,
        })
      : null;
  }

  if (credential) {
    const principal = await resolveTemporaryUserSession(
      database,
      await digestTemporaryCredential(credential)
    );
    if (principal) {
      return Object.freeze({
        clearTemporaryCredential: false,
        principal,
        sessionRotated: false,
        temporary: true,
      });
    }
  }

  if (!options.createTemporary) return null;
  const createdCredential = createTemporaryCredential();
  const expiresAt = new Date(Date.now() + TEMPORARY_SESSION_LIFETIME_MS);
  const session = await createTemporaryUserSession(database, {
    credentialDigest: await digestTemporaryCredential(createdCredential),
    displayName: "Temporary operator",
    expiresAt,
  });
  return Object.freeze({
    clearTemporaryCredential: Boolean(credential),
    createdCredential,
    expiresAt,
    principal: session.principal,
    // A presented-but-unrecognized credential means the previous guest session
    // was silently rotated (expired, unknown database, reset data). Surface it
    // so the UI can warn instead of showing a bare empty workspace.
    sessionRotated: Boolean(credential),
    temporary: true,
  });
}
