// Fetches the private binary asset pack (adea-ai/assets) into vendor/assets.
// The pack holds licensed + production 3D models, textures, and audio that
// must never be committed to agent-hq. CI lanes without the pack still work:
// scripts/sync-assets.mjs degrades to manifests-only with a loud warning.
//
// Sources, in order:
//   1. AGENT_HQ_ASSETS_DIR — copy from a local checkout (developers: clone
//      adea-ai/assets next to agent-hq and point here, no credentials needed).
//   2. ASSETS_READ_TOKEN — download the repo tarball/zipball over HTTPS
//      (GitHub Actions release lanes, Cloudflare Builds). Fine-grained PAT
//      with contents:read on adea-ai/assets only.
//   3. The developer's own `gh` auth (gh api tarball, no shared secret).
//
// Usage: bun scripts/fetch-assets.mjs [--force] [--ref <branch|sha>]

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(repoRoot, "vendor/assets");
const markerPath = join(destination, ".fetch.json");
const packRepo = process.env.AGENT_HQ_ASSETS_REPO ?? "adea-ai/assets";

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const refFlag = argv.indexOf("--ref");
const ref = refFlag === -1 ? "main" : (argv[refFlag + 1] ?? "main");

function fail(message) {
  console.error(`[Agent HQ] asset fetch failed: ${message}`);
  console.error(
    "[Agent HQ] Provide the pack via AGENT_HQ_ASSETS_DIR, ASSETS_READ_TOKEN, or an authenticated `gh` CLI. See scripts/fetch-assets.mjs header."
  );
  process.exit(1);
}

async function marker() {
  try {
    return JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return null;
  }
}

async function resolveHeadSha(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (!token) {
    const gh = spawnSync("gh", ["api", `repos/${packRepo}/commits/${ref}`, "--jq", ".sha"], {
      encoding: "utf8",
    });
    if (!gh.error && gh.status === 0 && /^[0-9a-f]{40}$/.test(gh.stdout.trim())) {
      return gh.stdout.trim();
    }
    return null;
  }
  const response = await fetch(`https://api.github.com/repos/${packRepo}/commits/${ref}`, {
    headers: { ...headers, Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return null;
  const sha = (await response.json())?.sha;
  return typeof sha === "string" ? sha : null;
}

async function downloadZipball(token, outPath) {
  // api.github.com redirects to a signed codeload URL; follow it manually so
  // the bearer token is only sent to api.github.com, never to the CDN host.
  let url = `https://api.github.com/repos/${packRepo}/zipball/${ref}`;
  let headers = token ? { Authorization: `Bearer ${token}` } : {};
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(url, { headers, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location"), url).toString();
      headers = {};
      continue;
    }
    if (!response.ok) {
      fail(`pack download returned HTTP ${response.status} for ${packRepo}@${ref}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(outPath, buffer);
    return;
  }
  fail("too many redirects while downloading the asset pack");
}

async function extractZipball(zipPath) {
  const bunRuntime =
    typeof globalThis === "object" && globalThis !== null ? globalThis.Bun : undefined;
  if (bunRuntime && typeof bunRuntime.unzipSync === "function") {
    const entries = bunRuntime.unzipSync(new Uint8Array(await readFile(zipPath)));
    const pairs = entries instanceof Map ? [...entries] : Object.entries(entries);
    for (const [name, data] of pairs) {
      const relative = String(name).split("/").slice(1).join("/");
      if (!relative || String(name).endsWith("/")) continue;
      const target = join(destination, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    return;
  }
  const unzip = spawnSync("unzip", ["-q", "-o", zipPath, "-d", `${destination}.unzip`], {
    stdio: "inherit",
  });
  if (unzip.error || unzip.status !== 0) {
    fail("no zip extractor available (need Bun >= 1.2 or the `unzip` binary)");
  }
  const topLevel = spawnSync("ls", [`${destination}.unzip`], { encoding: "utf8" });
  const root = join(`${destination}.unzip`, (topLevel.stdout ?? "").split("\n")[0] ?? "");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(root, destination, { recursive: true });
  await rm(`${destination}.unzip`, { recursive: true, force: true });
}

const localDir = process.env.AGENT_HQ_ASSETS_DIR;
if (localDir) {
  if (!existsSync(localDir)) fail(`AGENT_HQ_ASSETS_DIR does not exist: ${localDir}`);
  await rm(destination, { recursive: true, force: true });
  await cp(localDir, destination, { recursive: true });
  await writeFile(
    markerPath,
    `${JSON.stringify({ source: `local:${localDir}`, at: new Date().toISOString() })}\n`
  );
  console.log(`[Agent HQ] asset pack linked from ${localDir}`);
  process.exit(0);
}

const existing = await marker();
if (!force && existing?.sha) {
  const headSha = await resolveHeadSha(process.env.ASSETS_READ_TOKEN ?? null).catch(() => null);
  if (headSha && headSha === existing.sha) {
    console.log(
      `[Agent HQ] asset pack already current at ${headSha.slice(0, 12)}; skipping fetch.`
    );
    process.exit(0);
  }
  if (!headSha) {
    console.warn("[Agent HQ] cannot reach the asset-pack remote; keeping the existing pack.");
    process.exit(0);
  }
}

// One download path for every remote fetch: `gh` is only ever a token
// source, never a transport (`gh api` does not follow the zipball 302 to
// codeload, so piping it yields an empty archive).
let token = process.env.ASSETS_READ_TOKEN ?? null;
if (!token) {
  const probe = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: "pipe" });
  const candidate = probe.error || probe.status !== 0 ? "" : (probe.stdout ?? "").trim();
  if (/^\S+$/.test(candidate)) token = candidate;
}
if (!token) {
  fail("no ASSETS_READ_TOKEN and no authenticated `gh` CLI");
}
const outZip = join(tmpdir(), `agent-hq-assets-${process.pid}.zip`);
await downloadZipball(token, outZip);
await extractZipball(outZip);
await rm(outZip, { force: true });

const sha = (await resolveHeadSha(token ?? null).catch(() => null)) ?? ref;
await mkdir(destination, { recursive: true });
await writeFile(
  markerPath,
  `${JSON.stringify({ source: `remote:${packRepo}@${ref}`, sha, at: new Date().toISOString() })}\n`
);
console.log(`[Agent HQ] asset pack fetched to vendor/assets (${packRepo}@${ref}).`);
