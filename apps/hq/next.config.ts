import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@agent-hq/scene-runtime", "@agent-hq/ui"],
};

export default nextConfig;
