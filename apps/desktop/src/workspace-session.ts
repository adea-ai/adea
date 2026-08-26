import type { AgentHqApiClient, ApiWorkspaceBootstrapResponse } from "@agent-hq/api-client";
import type { DesktopSession } from "@agent-hq/auth/desktop";

type WorkspaceClient = Pick<AgentHqApiClient, "bootstrapWorkspace" | "claimTemporaryWorkspace">;

export type TemporaryWorkspaceVault = Readonly<{
  clear(): Promise<void>;
  save(credential: string): Promise<void>;
}>;

export type DesktopWorkspaceBootstrap = Readonly<{
  accountLabel: string | null;
  temporary: boolean;
  temporaryCredential: string | null;
  temporaryCredentialPersisted: boolean;
  workspace: ApiWorkspaceBootstrapResponse["activeWorkspace"];
  workspaces: ApiWorkspaceBootstrapResponse["workspaces"];
}>;

export function createWorkspaceRequestGuard() {
  let latestRequest = 0;
  return Object.freeze({
    begin() {
      const request = ++latestRequest;
      return () => request === latestRequest;
    },
    invalidate() {
      latestRequest += 1;
    },
  });
}

export async function loadTemporaryWorkspaceCredential(
  load: () => Promise<string | null>,
  timeoutMs = 1_500,
): Promise<string | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      load().catch(() => null),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function bootstrapDesktopWorkspace({
  createClient,
  session,
  storedTemporaryCredential,
  onTemporaryCredentialClaimed,
  temporaryVault,
}: Readonly<{
  createClient(
    input: Readonly<{
      session?: DesktopSession;
      temporaryCredential?: string;
    }>,
  ): WorkspaceClient;
  session?: DesktopSession;
  storedTemporaryCredential: string | null;
  onTemporaryCredentialClaimed?(): void;
  temporaryVault: TemporaryWorkspaceVault;
}>): Promise<DesktopWorkspaceBootstrap> {
  let temporaryCredential = storedTemporaryCredential;
  let temporaryCredentialPersisted = Boolean(storedTemporaryCredential);

  if (session && temporaryCredential) {
    const claimingClient = createClient({ session, temporaryCredential });
    await claimingClient.claimTemporaryWorkspace(temporaryCredential);
    await temporaryVault.clear().catch(() => undefined);
    temporaryCredential = null;
    temporaryCredentialPersisted = false;
    onTemporaryCredentialClaimed?.();
  }

  const client = createClient({
    ...(session ? { session } : {}),
    ...(temporaryCredential ? { temporaryCredential } : {}),
  });
  const result = await client.bootstrapWorkspace();

  if (result.principal.temporary && !temporaryCredential) {
    if (!result.temporaryCredential) {
      throw new Error("Desktop guest credential is unavailable");
    }
    temporaryCredential = result.temporaryCredential;
    try {
      await temporaryVault.save(result.temporaryCredential);
      temporaryCredentialPersisted = true;
    } catch {
      // A device vault failure must not prevent a guest from using this session.
      temporaryCredentialPersisted = false;
    }
  }

  return Object.freeze({
    accountLabel: result.principal.displayName ?? null,
    temporary: result.principal.temporary,
    temporaryCredential,
    temporaryCredentialPersisted,
    workspace: result.activeWorkspace,
    workspaces: result.workspaces,
  });
}
