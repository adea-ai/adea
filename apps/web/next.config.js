import path from "node:path";

const extraDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages resolve to TypeScript sources in development (see the
  // "development" export condition in each package.json). Their sources use
  // tsc-style "./x.js" specifiers, so teach webpack to map those back onto
  // the .ts/.tsx sources.
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
  },
  // Permit the stable Tailscale MagicDNS hostname to load the dev client and
  // HMR resources. Additional host/IP origins can be supplied as a comma-
  // separated NEXT_ALLOWED_DEV_ORIGINS value when using a raw tailnet IP.
  allowedDevOrigins: ["*.localhost", "*.ts.net", "amf-mb-pro", "127.0.0.1", ...extraDevOrigins],
  turbopack: { root: path.resolve(import.meta.dirname, "../..") },
  transpilePackages: [
    "@agent-hq/api-client",
    "@agent-hq/app-core",
    "@agent-hq/asset-manifests",
    "@agent-hq/character-designer-scene",
    "@agent-hq/room-designer-scene",
    "@agent-hq/audio",
    "@agent-hq/characters",
    "@agent-hq/data",
    "@agent-hq/db",
    "@agent-hq/interior",
    "@agent-hq/pets",
    "@agent-hq/hq-scenes",
    "@agent-hq/scene-shell",
    "@agent-hq/scene-telemetry",
    "@agent-hq/ui",
    "@agent-hq/scene-runtime",
    "@agent-hq/state",
    "@agent-hq/types",
    "@agent-hq/workspace-ui",
  ],
  async headers() {
    const assetCacheControl =
      process.env.NODE_ENV === "development"
        ? "no-store, no-cache, must-revalidate"
        : "public, max-age=86400, stale-while-revalidate=604800";
    return [
      { source: "/assets/:path*", headers: [{ key: "Cache-Control", value: assetCacheControl }] },
    ];
  },
};

export default nextConfig;
