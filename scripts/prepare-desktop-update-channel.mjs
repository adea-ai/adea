import { readFile, writeFile } from "node:fs/promises";

const RELEASE_ASSET_PATH = /^\/repos\/adea-ai\/adea\/releases\/assets\/(\d+)$/;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function publicChannelUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("desktop update channel must use HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("desktop update channel URL must not contain credentials, query, or fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function releaseAssetId(value, platform) {
  const url = new URL(value);
  const match = url.hostname === "api.github.com" && url.pathname.match(RELEASE_ASSET_PATH);
  if (!match) throw new Error(`${platform} does not reference an Agent HQ GitHub release asset`);
  return Number(match[1]);
}

export function prepareUpdateManifest(manifestValue, assetValues, channelValue) {
  const manifest = structuredClone(requireObject(manifestValue, "update manifest"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) {
    throw new Error("update manifest version must be an exact semantic version");
  }

  const platforms = requireObject(manifest.platforms, "update manifest platforms");
  if (Object.keys(platforms).length === 0) throw new Error("update manifest has no platforms");
  if (!Array.isArray(assetValues)) throw new Error("release assets must be an array");

  const assets = new Map(
    assetValues.map((assetValue) => {
      const asset = requireObject(assetValue, "release asset");
      if (!Number.isSafeInteger(asset.id) || typeof asset.name !== "string" || !asset.name) {
        throw new Error("release asset must contain a numeric id and non-empty name");
      }
      return [asset.id, asset];
    })
  );
  const channel = publicChannelUrl(channelValue);
  const assetNames = new Set();

  for (const [platform, entryValue] of Object.entries(platforms)) {
    const entry = requireObject(entryValue, `${platform} update entry`);
    if (typeof entry.signature !== "string" || !entry.signature.trim()) {
      throw new Error(`${platform} update entry has no signature`);
    }
    if (typeof entry.url !== "string") throw new Error(`${platform} update entry has no URL`);

    const assetId = releaseAssetId(entry.url, platform);
    const asset = assets.get(assetId);
    if (!asset) throw new Error(`${platform} references missing release asset ${assetId}`);
    if (asset.url !== entry.url) {
      throw new Error(`${platform} release asset ${assetId} URL does not match the inventory`);
    }

    entry.url = new URL(encodeURIComponent(asset.name), channel).href;
    assetNames.add(asset.name);
  }

  return { manifest, assetNames: [...assetNames].sort() };
}

async function main() {
  const [manifestPath, assetsPath, channelUrl, outputManifestPath, outputAssetsPath] =
    process.argv.slice(2);
  if (!outputAssetsPath) {
    throw new Error(
      "usage: prepare-desktop-update-channel.mjs <latest.json> <assets.json> <channel-url> <output-latest.json> <output-assets.json>"
    );
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const assets = JSON.parse(await readFile(assetsPath, "utf8"));
  const prepared = prepareUpdateManifest(manifest, assets, channelUrl);
  await writeFile(outputManifestPath, `${JSON.stringify(prepared.manifest, null, 2)}\n`);
  await writeFile(outputAssetsPath, `${JSON.stringify(prepared.assetNames, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
