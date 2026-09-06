import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Publishes the moat-free shared packages (@adea-ai/ui, @adea-ai/asset-manifests,
// @adea-ai/audio) to the public npm registry so the private agent-sim repo —
// and, later, the public adea repo — consume them without any registry auth.
// These three packages have zero @adea-ai/* transitive deps and contain no
// engine, simulation, or binary-asset code; that is what makes public
// publishing safe. Never add an engine package to PUBLISH_PACKAGES.
//
// The npm `adea` org must exist and NPM_TOKEN must be an automation token
// with publish rights on it. Versions come from each package.json
// (release-please lockstep); already-published versions are skipped, so the
// script is safe to re-run and runs on every main push touching these paths.

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const PUBLISH_PACKAGES = ["packages/asset-manifests", "packages/audio", "packages/ui"];

function sh(args, cwd, extraEnv) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(extraEnv ?? {}) },
  });
  if (result.error) throw result.error;
  return result;
}

async function publishedVersion(name) {
  const result = sh(["npm", "view", `${name}`, "version"], repoRoot);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

for (const relative of PUBLISH_PACKAGES) {
  const source = resolve(repoRoot, relative);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const { name, version } = manifest;
  if (manifest.private) {
    throw new Error(`[publish] refusing to publish ${name}: remove "private": true first`);
  }
  if (await publishedVersion(name).then((v) => v === version)) {
    console.log(`[publish] ${name}@${version} already published; skipping.`);
    continue;
  }
  // Stage an isolated copy with workspace: ranges resolved to their locked
  // versions so the published tarball has no workspace: protocol leftovers.
  const stage = await mkdtemp(join(tmpdir(), "adea-publish-"));
  await cp(source, join(stage, "package"), { recursive: true });
  const stagedManifestPath = join(stage, "package", "package.json");
  const staged = JSON.parse(await readFile(stagedManifestPath, "utf8"));
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dep, range] of Object.entries(staged[section] ?? {})) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        try {
          const depManifest = JSON.parse(
            await readFile(join(repoRoot, "node_modules", dep, "package.json"), "utf8")
          );
          staged[section][dep] = `^${depManifest.version}`;
        } catch {
          throw new Error(`[publish] cannot resolve ${range} for ${dep} in ${name}`);
        }
      }
    }
  }
  await writeFile(stagedManifestPath, `${JSON.stringify(staged, null, 2)}\n`);
  console.log(`[publish] publishing ${name}@${version}...`);
  const result = sh(["npm", "publish", "--access", "public"], join(stage, "package"));
  await rm(stage, { recursive: true, force: true });
  if (result.status !== 0) {
    // Tolerate publish races: concurrent lanes may both pass the version
    // check, then exactly one wins the PUT. A 403 overwrite for the version
    // we wanted is convergence, not failure.
    const output = `${result.stdout ?? ""}
${result.stderr ?? ""}`;
    if (
      output.includes("cannot publish over the previously published versions") &&
      (await publishedVersion(name)) === version
    ) {
      console.log(`[publish] ${name}@${version} won by a concurrent lane; continuing.`);
      continue;
    }
    console.error(result.stdout, result.stderr);
    throw new Error(`[publish] failed for ${name}@${version}`);
  }
  console.log(`[publish] published ${name}@${version}.`);
}
