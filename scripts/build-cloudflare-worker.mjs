import { spawnSync } from "node:child_process";
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
// apps/web/CLOUDFLARE.md): frozen install from the monorepo root, then the
// OpenNext build inside apps/web (which runs sync-assets, cf-typegen, and
// next build via the app's `build` script). No post-build patching is needed.
run(["install", "--frozen-lockfile"], repositoryRoot);
run(["x", "opennextjs-cloudflare", "build"], webRoot);
