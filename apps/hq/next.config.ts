import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@agent-hq/asset-manifests",
    "@agent-hq/ithappy",
    "@agent-hq/rooms",
    "@agent-hq/scene-hq-home",
    "@agent-hq/scene-hq-work",
    "@agent-hq/scene-runtime",
    "@agent-hq/ui",
  ],
};

export default nextConfig;
