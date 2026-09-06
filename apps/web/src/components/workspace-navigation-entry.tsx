"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { createApiClient, type AgentHqApiClient } from "@adea-ai/api-client";
import { useAgentListQuery, useWorkspaceBootstrapQuery } from "@adea-ai/data";
import { useWorkspaceStore } from "@adea-ai/state";
import type { WorkspaceSummary } from "@adea-ai/types";
import type {
  WorkspacePlatformServices,
  WorkspacePluginsProvider,
} from "@adea-ai/workspace-ui/platform";
import type { RegistryPluginsProviderOptions } from "@adea-ai/workspace-ui/plugins";
import { createBrowserSettingsProvider } from "@adea-ai/workspace-ui/preferences";
import type { WorkspaceView } from "@adea-ai/workspace-ui/workspace-view-toggle";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import type { WorkspaceShellProps } from "./workspace-shell";
import packageJson from "../../package.json";

const appVersion = packageJson.version;

const ConventionalWorkspace = dynamic(
  () =>
    import("./conventional-workspace-entry").then(
      ({ ConventionalWorkspaceEntry }) => ConventionalWorkspaceEntry
    ),
  { loading: () => <WorkspaceEntryLoading /> }
);

const SpatialWorkspace = dynamic(
  () => import("./workspace-shell").then(({ WorkspaceShell }) => WorkspaceShell),
  { loading: () => <WorkspaceEntryLoading /> }
);

const RoomDesignerWorkspace = dynamic(
  () => import("./room-designer-entry").then(({ RoomDesignerEntry }) => RoomDesignerEntry),
  { loading: () => <WorkspaceEntryLoading /> }
);

const GlobalWorkspaceRail = dynamic(
  () =>
    import("@adea-ai/workspace-ui/global-workspace-rail").then(
      ({ GlobalWorkspaceRail: Rail }) => Rail
    ),
  { loading: () => <WorkspaceRailLoading />, ssr: false }
);

const WorkspaceAboutDialog = dynamic(
  () =>
    import("@adea-ai/workspace-ui/workspace-about-dialog").then(
      ({ WorkspaceAboutDialog: AboutDialog }) => AboutDialog
    ),
  { ssr: false }
);

const PluginsDialog = dynamic(
  () => import("@adea-ai/workspace-ui/plugins-dialog").then((module) => module.PluginsDialog),
  { ssr: false }
);

const WorkspaceSettingsDialog = dynamic(
  () =>
    import("@adea-ai/workspace-ui/workspace-settings").then(
      ({ WorkspaceSettingsDialog: SettingsDialog }) => SettingsDialog
    ),
  { ssr: false }
);

function WorkspaceEntryLoading() {
  return (
    <main className="conventional-workspace conventional-workspace--loading" aria-busy="true">
      <p>Opening workspace…</p>
    </main>
  );
}

function WorkspaceRailLoading() {
  return <nav className="global-rail global-rail--loading" aria-hidden="true" />;
}

function WorkspaceSettingsOverlay({
  accountAuthenticated,
  accountLabel,
  busy,
  client,
  onClose,
  onOpenAgents,
  onSignIn,
  onSignOut,
  open,
  services,
  workspace,
}: Readonly<{
  accountAuthenticated: boolean;
  accountLabel: string;
  busy: boolean;
  client: AgentHqApiClient;
  onClose: () => void;
  onOpenAgents: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  open: boolean;
  services: WorkspacePlatformServices;
  workspace: WorkspaceSummary;
}>) {
  const agentsQuery = useAgentListQuery(client, workspace.id);
  return (
    <WorkspaceSettingsDialog
      accountAuthenticated={accountAuthenticated}
      accountLabel={accountLabel}
      agents={agentsQuery.data ?? []}
      busy={busy}
      onClose={onClose}
      onOpenAgents={onOpenAgents}
      onSignIn={onSignIn}
      onSignOut={onSignOut}
      open={open}
      services={services}
      workspace={workspace}
    />
  );
}

function createDeferredPluginsProvider(
  options: RegistryPluginsProviderOptions
): WorkspacePluginsProvider {
  let provider: Promise<WorkspacePluginsProvider> | undefined;
  let loaded: WorkspacePluginsProvider | undefined;
  const load = () => {
    provider ??= import("@adea-ai/workspace-ui/plugins")
      .then(({ createRegistryPluginsProvider }) => createRegistryPluginsProvider(options))
      .then((value) => {
        loaded = value;
        return value;
      });
    return provider;
  };
  return {
    getState: () => loaded?.getState?.() ?? "idle",
    list: () => load().then((value) => value.list()),
    requestInstall: (pluginId) => load().then((value) => value.requestInstall(pluginId)),
  };
}

export function WorkspaceNavigationEntry({
  virtual,
  virtualProps,
  roomDesigner = false,
}: Readonly<{
  virtual: boolean;
  virtualProps: WorkspaceShellProps;
  roomDesigner?: boolean;
}>) {
  const [client] = useState(() => createApiClient());
  const [roomDesignerEnabled, setRoomDesignerEnabled] = useState(roomDesigner);
  const workspaceIdRef = useRef<string | undefined>(undefined);
  const userIdRef = useRef<string | undefined>(undefined);
  const [services] = useState<WorkspacePlatformServices>(() => ({
    account: {
      onSignIn: () => window.location.assign("@adea-ai/auth/sign-in?returnTo=%2F"),
      onSignOut: async () => {
        const { createNeonClientAdapter } = await import("@adea-ai/auth/client");
        await createNeonClientAdapter().signOut();
        window.location.assign("/");
      },
    },
    app: { name: "Agent HQ", platform: "web", version: appVersion },
    plugins: createDeferredPluginsProvider({
      client,
      getWorkspaceId: () => workspaceIdRef.current,
      getUserId: () => userIdRef.current,
      requestedHarness: "codex",
    }),
    settings: createBrowserSettingsProvider(),
  }));
  const bootstrap = useWorkspaceBootstrapQuery(client);
  const globalPanel = useWorkspaceStore((state) => state.globalPanel);
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const setActiveSurface = useWorkspaceStore((state) => state.setActiveSurface);
  const setGlobalPanel = useWorkspaceStore((state) => state.setGlobalPanel);
  const setSelectedScene = useWorkspaceStore((state) => state.setSelectedScene);
  const switchWorkspace = useWorkspaceStore((state) => state.switchWorkspace);
  const [viewParam, setViewParam] = useQueryState(
    "view",
    parseAsStringLiteral(["chat", "virtual"] as const)
      .withDefault(virtual ? "virtual" : "chat")
      .withOptions({ clearOnDefault: false, history: "replace" })
  );
  const [sceneParam, setScene] = useQueryState(
    "scene",
    parseAsStringLiteral(["home", "work"] as const)
      .withDefault(virtualProps.initialScene)
      .withOptions({ clearOnDefault: false, history: "replace" })
  );
  const view: WorkspaceView = viewParam;
  const requestedScene =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("scene")
      ? sceneParam
      : undefined;
  const setRoomDesignerRoute = (enabled: boolean) => {
    setRoomDesignerEnabled(enabled);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("roomDesigner", enabled ? "1" : "0");
    if (enabled) nextUrl.searchParams.set("view", "virtual");
    window.history.replaceState(null, "", nextUrl);
    if (enabled && view !== "virtual") void setViewParam("virtual");
  };
  const activeWorkspace =
    bootstrap.data?.workspaces.find(({ id }) => id === selectedWorkspaceId) ??
    bootstrap.data?.workspaces.find(({ scene }) => scene === requestedScene) ??
    bootstrap.data?.activeWorkspace;
  const scene = activeWorkspace?.scene ?? sceneParam;
  const hashSettingsOpen =
    typeof window !== "undefined" && window.location.hash.startsWith("#settings");
  const settingsOpen = globalPanel === "settings" || hashSettingsOpen;
  const principal = bootstrap.data?.principal;
  const accountAuthenticated = Boolean(principal && !principal.temporary);
  const accountLabel = accountAuthenticated
    ? (principal?.displayName ?? "Account")
    : "Not signed in";

  useEffect(() => {
    workspaceIdRef.current = activeWorkspace?.id;
    userIdRef.current = principal?.userId;
  }, [activeWorkspace?.id, principal?.userId]);

  useEffect(() => {
    if (!activeWorkspace) return;
    if (selectedWorkspaceId !== activeWorkspace.id)
      switchWorkspace(activeWorkspace.id, activeWorkspace.scene);
    setSelectedScene(activeWorkspace.scene);
    if (sceneParam !== activeWorkspace.scene) void setScene(activeWorkspace.scene);
  }, [
    activeWorkspace?.id,
    activeWorkspace?.scene,
    sceneParam,
    selectedWorkspaceId,
    setScene,
    setSelectedScene,
    switchWorkspace,
  ]);

  useEffect(() => {
    const openDeepLinkedSettings = () => {
      if (window.location.hash.startsWith("#settings")) setGlobalPanel("settings");
    };
    openDeepLinkedSettings();
    window.addEventListener("hashchange", openDeepLinkedSettings);
    return () => window.removeEventListener("hashchange", openDeepLinkedSettings);
  }, [setGlobalPanel]);

  const changeView = (nextView: WorkspaceView) => {
    void setViewParam(nextView);
  };
  const openSettings = (section: "account" | "input-notifications" | "integrations") => {
    window.history.replaceState(null, "", `#settings/${section}`);
    // Settings is a global overlay. Keep the current surface mounted so the
    // virtual scene does not disappear before its dialog can open.
    setGlobalPanel("settings");
  };
  const openSearch = () => {
    setGlobalPanel("search");
    if (view !== "chat") changeView("chat");
  };

  return (
    <div className={`workspace-frame workspace-frame--${view}`}>
      <GlobalWorkspaceRail
        account={{
          authenticated: accountAuthenticated,
          label: accountLabel,
          onSignIn: () => services.account?.onSignIn(),
          onSignOut: () => void services.account?.onSignOut(),
          platform: "web",
        }}
        onOpenNotifications={() => openSettings("input-notifications")}
        onOpenAbout={() => setGlobalPanel("about")}
        onOpenPlugins={() => setGlobalPanel("plugins")}
        onOpenSearch={openSearch}
        onOpenSettings={() => openSettings("account")}
        activeWorkspace={activeWorkspace}
        onWorkspaceChange={(workspace) => {
          if (workspace.id === activeWorkspace?.id) return;
          switchWorkspace(workspace.id, workspace.scene);
          void setScene(workspace.scene);
        }}
        onViewChange={changeView}
        view={view}
        workspaces={bootstrap.data?.workspaces ?? []}
      />
      <div className="workspace-frame__surface">
        {view === "virtual" ? (
          roomDesignerEnabled ? (
            <RoomDesignerWorkspace
              key={activeWorkspace?.id ?? scene}
              initialCharacter={virtualProps.initialCharacter}
              initialScene={scene}
              onClose={() => setRoomDesignerRoute(false)}
            />
          ) : (
            <SpatialWorkspace
              key={activeWorkspace?.id ?? scene}
              {...virtualProps}
              apiClient={client}
              initialScene={scene}
              onOpenRoomDesigner={() => setRoomDesignerRoute(true)}
              onWorkspaceViewChange={changeView}
              services={services}
              workspaceView={view}
            />
          )
        ) : (
          <ConventionalWorkspace
            client={client}
            manageSettings={false}
            onViewChange={changeView}
            services={services}
          />
        )}
      </div>
      {activeWorkspace && settingsOpen ? (
        <WorkspaceSettingsOverlay
          accountAuthenticated={accountAuthenticated}
          accountLabel={accountLabel}
          busy={services.account?.busy ?? false}
          client={client}
          onClose={() => setGlobalPanel(null)}
          onOpenAgents={() => {
            setActiveSurface("agents");
            setGlobalPanel(null);
            changeView("chat");
          }}
          onSignIn={() => services.account?.onSignIn()}
          onSignOut={() => void services.account?.onSignOut()}
          open
          services={services}
          workspace={activeWorkspace}
        />
      ) : null}
      <PluginsDialog
        open={globalPanel === "plugins" && Boolean(activeWorkspace)}
        onClose={() => setGlobalPanel(null)}
        provider={services.plugins}
      />
      <WorkspaceAboutDialog
        appName={services.app?.name}
        open={globalPanel === "about"}
        onClose={() => setGlobalPanel(null)}
        platform={services.app?.platform}
        version={services.app?.version}
      />
    </div>
  );
}
