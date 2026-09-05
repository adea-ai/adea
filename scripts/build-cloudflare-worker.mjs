import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

// Mirrors the Cloudflare Workers Builds trigger for agent-hq-web (see
// apps/web/CLOUDFLARE.md): frozen install from the monorepo root, workspace
// dependency builds (so dist output exists exactly like a local checkout —
// turbo's dependsOn does this for every other lane, but the OpenNext build
// only runs the app's own `build` script), then the OpenNext build inside
// apps/web (sync-assets, cf-typegen, and next build). No post-build patching
// is needed.
run(["install", "--frozen-lockfile"], repositoryRoot);

const webManifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, "apps/web/package.json"), "utf8")
);
const workspaceDepFilters = Object.keys({
  ...(webManifest.dependencies ?? {}),
  ...(webManifest.devDependencies ?? {}),
})
  .filter((name) => name.startsWith("@agent-hq/"))
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

// Production Worker artifacts must ship real models, never sync stubs: the
// private asset pack has to resolve here (local AGENT_HQ_ASSETS_DIR,
// vendor/assets via scripts/fetch-assets.mjs, or ASSETS_READ_TOKEN). Fail
// fast with setup instructions instead of deploying a model-less worker.
run(["scripts/fetch-assets.mjs"], repositoryRoot);
if (
  !process.env.AGENT_HQ_ASSETS_DIR &&
  !existsSync(resolve(repositoryRoot, "vendor/assets/packages/interior/assets"))
) {
  throw new Error(
    "Private asset pack is unavailable: set AGENT_HQ_ASSETS_DIR, pre-populate vendor/assets, " +
      "or provide ASSETS_READ_TOKEN (Cloudflare build variable) so scripts/fetch-assets.mjs can download adea-ai/assets. " +
      "Refusing to ship a Worker without models."
  );
}
run(["x", "opennextjs-cloudflare", "build"], webRoot);
