import type { CapacitorConfig } from "@capacitor/cli";

const webUrl = process.env.ADEA_WEB_URL?.trim();

const config: CapacitorConfig = {
  appId: "com.agenthq.mobile",
  appName: "Adea",
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
