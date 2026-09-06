"use client";

import { TooltipProvider } from "@adea/ui/components/ui/tooltip";
import { ConventionalWorkspaceShell } from "@adea/workspace-ui/conventional-workspace-shell";
import type { WorkspacePlatformServices } from "@adea/workspace-ui/platform";
import type { WorkspaceView } from "@adea/workspace-ui/workspace-view-toggle";
import type { AgentHqApiClient } from "@adea/api-client";

export function ConventionalWorkspaceEntry({
  client,
  manageSettings = true,
  onViewChange,
  services,
}: Readonly<{
  client: AgentHqApiClient;
  manageSettings?: boolean;
  onViewChange: (view: WorkspaceView) => void;
  services: WorkspacePlatformServices;
}>) {
  return (
    <TooltipProvider>
      <ConventionalWorkspaceShell
        manageSettings={manageSettings}
        onViewChange={onViewChange}
        view="chat"
        services={{ ...services, client }}
      />
    </TooltipProvider>
  );
}
