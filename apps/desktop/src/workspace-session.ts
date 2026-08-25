import type { AgentHqApiClient, ApiWorkspaceBootstrapResponse } from "@agent-hq/api-client";
import type { DesktopSession } from "@agent-hq/auth/desktop";

type WorkspaceClient = Pick<AgentHqApiClient, "bootstrapWorkspace" | "claimTemporaryWorkspace">;

export type TemporaryWorkspaceVault = Readonly<{
  clear(): Promise<void>;
  save(credential: string): Promise<void>;
}>;

export type DesktopWorkspaceBootstrap = Readonly<{
  temporary: boolean;
  temporaryCredential: string | null;
  workspace: ApiWorkspaceBootstrapResponse["activeWorkspace"];
  workspaces: ApiWorkspaceBootstrapResponse["workspaces"];
}>;

export async function bootstrapDesktopWorkspace({
  createClient,
  session,
  storedTemporaryCredential,
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
  temporaryVault: TemporaryWorkspaceVault;
}>): Promise<DesktopWorkspaceBootstrap> {
  let temporaryCredential = storedTemporaryCredential;

  if (session && temporaryCredential) {
    const claimingClient = createClient({ session, temporaryCredential });
    await claimingClient.claimTemporaryWorkspace(temporaryCredential);
    await temporaryVault.clear();
    temporaryCredential = null;
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
    await temporaryVault.save(result.temporaryCredential);
    temporaryCredential = result.temporaryCredential;
  }

  return Object.freeze({
    temporary: result.principal.temporary,
    temporaryCredential,
    workspace: result.activeWorkspace,
    workspaces: result.workspaces,
  });
}
