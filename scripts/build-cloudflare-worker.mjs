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
run(["x", "opennextjs-cloudflare", "build"], webRoot);
