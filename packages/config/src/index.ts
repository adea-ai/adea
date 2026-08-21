export type ClientPlatform = "web" | "desktop" | "mobile";

export type AgentHqConfig = {
  platform: ClientPlatform;
  apiBaseUrl: string;
  webUrl?: string;
};

export function defineAgentHqConfig(config: AgentHqConfig): AgentHqConfig {
  return Object.freeze({ ...config });
}

export const defaultAgentHqConfig = defineAgentHqConfig({
  platform: "web",
  apiBaseUrl: "/api",
});
