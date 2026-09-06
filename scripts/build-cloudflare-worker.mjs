import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const webRoot = resolve(repositoryRoot, "apps/web");

function run(args, cwd) {
  const result = spawnSync("bun", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Mirrors the Cloudflare Workers Builds trigger for the web app (see
// apps/web/CLOUDFLARE.md): frozen install from the monorepo root, workspace
// dependency builds (so dist output exists exactly like a local checkout —
// turbo's dependsOn does this for every other lane, but the OpenNext build
// only runs the app's own `build` script), then the OpenNext build inside
// apps/web (sync-assets, cf-typegen, and next build). No post-build patching
// is needed.
//
// This repository ships manifests only. The spatial engine (models,
// textures, audio) lives in the private agent-sim repo and is delivered
// through the entitlement-gated engine remote, so adea lanes never fetch
// the private asset pack and need no asset credentials.
run(["install", "--frozen-lockfile"], repositoryRoot);

const webManifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, "apps/web/package.json"), "utf8")
);
const workspaceDepFilters = Object.keys({
  ...(webManifest.dependencies ?? {}),
  ...(webManifest.devDependencies ?? {}),
})
  .filter((name) => name.startsWith("@adea/"))
  .map((name) => `--filter=${name}`);
run(["x", "turbo", "run", "build", ...workspaceDepFilters], repositoryRoot);

// Stamp the deployment commit SHA into the bundle so scene telemetry keeps
// release attribution without a hosting provider (the old platform's
// commit-SHA variable is gone). Next inlines process.env references at
// build time, so exporting here stamps both the server envelope default
// (DEPLOY_GIT_COMMIT_SHA) and the client release marker
// (NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA) with the exact commit being deployed,
// including Workers Builds previews. An explicitly provided
// DEPLOY_GIT_COMMIT_SHA always wins; when git is unavailable the variables
// stay unset and telemetry simply omits release metadata.
if (!process.env.DEPLOY_GIT_COMMIT_SHA) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const sha = revision.error || revision.status !== 0 ? "" : revision.stdout.trim();
  if (sha) process.env.DEPLOY_GIT_COMMIT_SHA = sha;
}
if (process.env.DEPLOY_GIT_COMMIT_SHA && !process.env.NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA) {
  process.env.NEXT_PUBLIC_DEPLOY_GIT_COMMIT_SHA = process.env.DEPLOY_GIT_COMMIT_SHA;
}
run(["scripts/sync-assets.mjs"], repositoryRoot);
run(["x", "opennextjs-cloudflare", "build"], webRoot);
