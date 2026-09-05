import type { AgentHqApiClient } from "@agent-hq/api-client";

import {
  categoryLabel,
  canonicalDigest,
  installationResponseState,
  loadRegistryArtifacts,
  mapRegistryCatalog,
  MarketplaceCatalogError,
  type VerifiedRegistryCatalog,
} from "./marketplace-catalog";
import type {
  WorkspacePlugin,
  WorkspacePluginCategory,
  WorkspacePluginDefinition,
  WorkspacePluginsProvider,
  WorkspacePluginsProviderState,
} from "./platform";

export const workspacePluginCategoryOrder = Object.freeze([
  "Productivity",
  "Communication",
  "Developer Tools",
  "Data & Analytics",
  "Business & Operations",
  "Finance",
  "Creativity",
  "Education & Research",
  "Scientific Research",
  "Security",
] satisfies readonly WorkspacePluginCategory[]);

const popularNames = [
  "gmail",
  "github",
  "google-drive",
  "google-calendar",
  "notion",
  "slack",
] as const;
export const popularWorkspacePluginIds = Object.freeze(
  popularNames.map((name) => `plugin:openai-official:${name}`)
);

export type WorkspacePluginFilter = Readonly<{
  ownership: "all" | WorkspacePlugin["ownership"];
  type: "all" | "connectors" | "skills";
}>;

export const defaultPluginFilter: WorkspacePluginFilter = Object.freeze({
  ownership: "all",
  type: "all",
});

export type RegistryPluginsProviderOptions = Readonly<{
  client: AgentHqApiClient | (() => AgentHqApiClient);
  getWorkspaceId: () => string | undefined;
  getUserId: () => string | undefined;
  requestedHarness?: string;
}>;

export function createRegistryPluginsProvider(
  options: RegistryPluginsProviderOptions
): WorkspacePluginsProvider {
  let cache: VerifiedRegistryCatalog | undefined;
  let cacheWorkspaceId: string | undefined;
  let state: WorkspacePluginsProviderState = "idle";
  const apiClient = () =>
    typeof options.client === "function" ? options.client() : options.client;

  const list = async (): Promise<readonly WorkspacePlugin[]> => {
    const workspaceId = options.getWorkspaceId();
    if (!workspaceId) {
      state = "unavailable";
      throw new MarketplaceCatalogError("unavailable", "A workspace is required to load plugins");
    }
    if (cacheWorkspaceId !== workspaceId) {
      cache = undefined;
      cacheWorkspaceId = workspaceId;
    }
    state = "loading";
    try {
      cache = await loadRegistryArtifacts(apiClient(), workspaceId);
      state = cache.state === "stale" ? "stale" : "ready";
      return mapRegistryCatalog(cache.catalog, cache.installations);
    } catch (error) {
      if (error instanceof MarketplaceCatalogError && error.state === "verification-failure") {
        state = "verification-failure";
        throw error;
      }
      if (cache) {
        state = "stale";
        return mapRegistryCatalog(cache.catalog, cache.installations);
      }
      state = error instanceof MarketplaceCatalogError ? error.state : "unavailable";
      throw error;
    }
  };

  const requestInstall = async (pluginId: string): Promise<readonly WorkspacePlugin[]> => {
    const workspaceId = options.getWorkspaceId();
    const userId = options.getUserId();
    if (!workspaceId || !userId) {
      state = "unavailable";
      throw new MarketplaceCatalogError(
        "unavailable",
        "A workspace and user identity are required to enable a plugin"
      );
    }
    if (!cache) await list();
    if (!cache)
      throw new MarketplaceCatalogError("unavailable", "The plugin catalog is unavailable");
    if (cache.state !== "ready") {
      state = "stale";
      throw new MarketplaceCatalogError(
        "stale",
        "The marketplace snapshot is stale; refresh before enabling a plugin"
      );
    }
    const plugin = cache.catalog.plugins.find((candidate) => candidate.pluginId === pluginId);
    if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
    const release = plugin.availableReleases.find(
      (candidate) => candidate.releaseId === plugin.currentReleaseId
    );
    if (!release)
      throw new MarketplaceCatalogError(
        "verification-failure",
        `Current release is missing: ${pluginId}`
      );
    if (release.contentResolution === "metadata-only") {
      state = "unavailable";
      throw new MarketplaceCatalogError(
        "unavailable",
        "This plugin is source metadata only and cannot be enabled"
      );
    }
    const idempotencyDigest = await canonicalDigest({
      pluginId,
      releaseId: release.releaseId,
      userId,
      workspaceId,
    });
    const response = await apiClient().requestMarketplaceInstall(workspaceId, {
      pluginId,
      releaseId: release.releaseId,
      canonicalContentDigest: release.canonicalContentDigest,
      requestedHarness: options.requestedHarness ?? "codex",
      workspaceIdentity: { userId, workspaceId },
      idempotencyKey: `marketplace:${idempotencyDigest.slice("sha256:".length)}`,
    });
    const installations = cache.installations.filter(
      (candidate) => candidate.pluginId !== pluginId
    );
    cache = {
      ...cache,
      installations: [
        ...installations,
        {
          pluginId,
          releaseId: response.releaseId,
          canonicalContentDigest: response.canonicalContentDigest,
          state: installationResponseState(response),
        },
      ],
    };
    return mapRegistryCatalog(cache.catalog, cache.installations);
  };

  return {
    getState: () => state,
    list,
    requestInstall,
  };
}

export function filterWorkspacePlugins(
  plugins: readonly WorkspacePlugin[],
  tab: "marketplace" | "yours",
  query: string,
  filter: WorkspacePluginFilter = defaultPluginFilter
): WorkspacePlugin[] {
  const needle = query.trim().toLocaleLowerCase();
  return plugins.filter(
    (plugin) =>
      (tab === "marketplace" || plugin.installed) &&
      (filter.type === "all" ||
        (filter.type === "connectors" && plugin.kind === "connector") ||
        (filter.type === "skills" && plugin.kind === "skill")) &&
      (filter.ownership === "all" || plugin.ownership === filter.ownership) &&
      (needle.length === 0 ||
        `${plugin.name} ${plugin.description} ${plugin.publisher} ${plugin.kind} ${plugin.category} ${plugin.capabilities.join(
          " "
        )} ${plugin.surfaces.join(" ")} ${plugin.keywords?.join(" ") ?? ""}`
          .toLocaleLowerCase()
          .includes(needle))
  );
}

export function groupWorkspacePlugins(plugins: readonly WorkspacePlugin[]) {
  const preferred = new Map<string, number>(
    workspacePluginCategoryOrder.map((category, index) => [category, index])
  );
  const names = [...new Set(plugins.map((plugin) => plugin.category))].sort(
    (left, right) =>
      (preferred.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (preferred.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
  );
  return names.flatMap((category) => {
    const items = plugins.filter((plugin) => plugin.category === category);
    return items.length > 0 ? [{ category, plugins: items }] : [];
  });
}

export function getPopularWorkspacePlugins(plugins: readonly WorkspacePlugin[]) {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return popularWorkspacePluginIds.flatMap((id) => {
    const plugin = byId.get(id);
    return plugin ? [plugin] : [];
  });
}

export { categoryLabel };
export type { WorkspacePluginDefinition };
