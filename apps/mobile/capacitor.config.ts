import type { CapacitorConfig } from "@capacitor/cli";

const webUrl = process.env.AGENT_HQ_WEB_URL?.trim();

const config: CapacitorConfig = {
  appId: "com.agenthq.mobile",
  appName: "Agent HQ",
  webDir: "www",
  ...(webUrl
    ? {
        server: {
          url: webUrl,
          cleartext: webUrl.startsWith("http://"),
        },
      }
    : {}),
};

export default config;
