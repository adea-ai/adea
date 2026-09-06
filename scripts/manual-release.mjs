import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

import { createReleasePlan, parseCommitLog } from "./manual-release-core.mjs";

const root = resolve(import.meta.dirname, "..");
const repository = "adea-ai/adea";
const releaseHeadPrefix = "release-please--branches--main";
// The emulated Linux fallback may run for up to 120 minutes. Keep the local
// orchestrator alive beyond that workflow deadline so it never tears down a
// healthy self-hosted runner while GitHub still owns the job.
const workflowWaitAttempts = 900;
const validationCommands = [
  ["bun", ["run", "format:check"]],
  ["bun", ["run", "lint"]],
  ["bun", ["run", "typecheck"]],
  ["bun", ["run", "test:unit"]],
  ["bun", ["run", "test:integration"]],
  ["bun", ["run", "build"]],
  ["bun", ["run", "test:smoke"]],
  ["bun", ["run", "test:e2e"]],
];

function quote(value) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value);
}

function run(command, args, { capture = false, displayArgs = args, env = process.env } = {}) {
  if (!capture) console.log(`\n$ ${[command, ...displayArgs].map(quote).join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout).trim() : "";
    throw new Error(
      `${command} ${displayArgs.join(" ")} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`
    );
  }
  return capture ? result.stdout.trim() : "";
}

function runJson(command, args) {
  const output = run(command, args, { capture: true });
  return output ? JSON.parse(output) : null;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForWorkflowRun(runId) {
  let consecutiveApiFailures = 0;
  for (let attempt = 0; attempt < workflowWaitAttempts; attempt += 1) {
    let workflowRun;
    try {
      workflowRun = runJson("gh", [
        "run",
        "view",
        String(runId),
        "--json",
        "status,conclusion,url",
      ]);
      consecutiveApiFailures = 0;
    } catch (error) {
      consecutiveApiFailures += 1;
      if (consecutiveApiFailures >= 12) throw error;
      console.warn(
        `Release status check failed; retrying (${consecutiveApiFailures}/12): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (workflowRun?.status === "completed") {
      if (workflowRun.conclusion !== "success") {
        throw new Error(
          `Release-assets workflow ${runId} completed with ${workflowRun.conclusion}: ${workflowRun.url}`
        );
      }
      return workflowRun;
    }
    sleep(10_000);
  }
  throw new Error(`Timed out waiting for release-assets workflow ${runId}.`);
}

function latestReleaseTag() {
  return run("gh", ["release", "view", "--json", "tagName", "--jq", ".tagName"], {
    capture: true,
  });
}

function runReleasePlease(subcommand, token) {
  // @google-automations/git-file-utils requires the undeclared
  // @octokit/request-error (upstream bug; only npm flat-hoisting provides
  // it). Bun's isolated linker leaves it out of scope, so run the pinned
  // local binary with node and NODE_PATH pointed at release-please's own
  // scope, which does contain @octokit/request-error.
  const releasePleaseBin = resolve(
    root,
    "node_modules/release-please/build/src/bin/release-please.js"
  );
  // resolve() collapses ".." lexically through the node_modules symlink,
  // so follow it to the real scope directory first.
  const releasePleaseScope = dirname(realpathSync(resolve(root, "node_modules/release-please")));
  const nodePath = process.env.NODE_PATH
    ? `${releasePleaseScope}${delimiter}${process.env.NODE_PATH}`
    : releasePleaseScope;
  const args = [
    releasePleaseBin,
    subcommand,
    `--token=${token}`,
    `--repo-url=${repository}`,
    "--target-branch=main",
    "--config-file=release-please-config.json",
    "--manifest-file=.release-please-manifest.json",
  ];
  run("node", args, {
    displayArgs: args.map((arg) => (arg.startsWith("--token=") ? "--token=***" : arg)),
    env: { ...process.env, NODE_PATH: nodePath },
  });
}

function findReleasePullRequests() {
  const pullRequests = runJson("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--base",
    "main",
    "--limit",
    "20",
    "--json",
    "number,title,headRefName,headRefOid,isDraft,url",
  ]);
  return pullRequests.filter(
    (pullRequest) =>
      pullRequest.headRefName.startsWith(releaseHeadPrefix) &&
      pullRequest.title.startsWith("chore(main): release ")
  );
}

function refreshMain() {
  run("git", ["fetch", "origin", "main", "--tags"]);
  run("git", ["merge", "--ff-only", "origin/main"]);
  return run("git", ["rev-parse", "HEAD"], { capture: true });
}

function billingIsPaused() {
  return run("gh", ["variable", "get", "CI_BILLING_PAUSED"], { capture: true }) === "true";
}

function workflowRunIds(event) {
  return new Set(
    runJson("gh", [
      "run",
      "list",
      "--workflow",
      "release-assets.yml",
      "--event",
      event,
      "--limit",
      "20",
      "--json",
      "databaseId",
    ]).map((item) => item.databaseId)
  );
}

function waitForPublishedReleaseAssets(tag, releaseSha) {
  let releaseRun;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const runs = runJson("gh", [
      "run",
      "list",
      "--workflow",
      "release-assets.yml",
      "--event",
      "release",
      "--commit",
      releaseSha,
      "--limit",
      "10",
      "--json",
      "databaseId,displayTitle,headSha,status,conclusion,url",
    ]);
    releaseRun = runs.find((item) => item.displayTitle === tag && item.headSha === releaseSha);
    if (releaseRun) break;
    sleep(2_000);
  }
  if (!releaseRun) throw new Error(`Timed out waiting for the ${tag} release-assets workflow.`);
  waitForWorkflowRun(releaseRun.databaseId);
  return releaseRun;
}

function dispatchReleaseAssets(tag) {
  const existingRunIds = workflowRunIds("workflow_dispatch");
  run("gh", ["workflow", "run", "release-assets.yml", "--field", `tag=${tag}`]);

  let releaseRun;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const runs = runJson("gh", [
      "run",
      "list",
      "--workflow",
      "release-assets.yml",
      "--event",
      "workflow_dispatch",
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion,url",
    ]);
    releaseRun = runs.find((item) => !existingRunIds.has(item.databaseId));
    if (releaseRun) break;
    sleep(2_000);
  }
  if (!releaseRun) throw new Error(`Timed out waiting for the ${tag} repair workflow.`);
  waitForWorkflowRun(releaseRun.databaseId);
  return releaseRun;
}

function verifyReleaseAssets(tag) {
  const release = runJson("gh", ["release", "view", tag, "--json", "assets,url"]);
  const desktopAssets = release.assets.filter((asset) => /agent[ ._-]*hq/i.test(asset.name));
  if (desktopAssets.length < 3 || !release.assets.some((asset) => asset.name === "latest.json")) {
    throw new Error(
      `${tag} is incomplete: expected latest.json and at least three Agent HQ desktop assets; found ${desktopAssets.length}.`
    );
  }
  const manifest = JSON.parse(
    run(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        `https://updates.adea.dev/desktop-updates/latest.json?release=${tag}`,
      ],
      { capture: true }
    )
  );
  const requiredPlatforms = ["darwin-aarch64", "linux-x86_64", "windows-x86_64"];
  if (manifest.version !== tag.replace(/^v/, "")) {
    throw new Error(`The public updater manifest is ${manifest.version}, expected ${tag}.`);
  }
  for (const platform of requiredPlatforms) {
    const entry = manifest.platforms?.[platform];
    if (
      typeof entry?.signature !== "string" ||
      entry.signature.length === 0 ||
      typeof entry?.url !== "string" ||
      !entry.url.startsWith("https://updates.adea.dev/desktop-updates/")
    ) {
      throw new Error(`The public updater manifest is missing a signed ${platform} package.`);
    }
  }
}

function releaseAssetsAreComplete(tag) {
  try {
    verifyReleaseAssets(tag);
    return true;
  } catch (error) {
    console.log(
      `Desktop assets for ${tag} need repair: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

function withReleaseRunners(callback) {
  const localRunners = billingIsPaused();
  if (localRunners) run("bun", ["scripts/release-runners.mjs", "start"]);
  try {
    return callback();
  } finally {
    if (localRunners) run("bun", ["scripts/release-runners.mjs", "stop"]);
  }
}

function cleanLocalReleaseState() {
  run("bun", ["scripts/release-runners.mjs", "clean"]);
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log("Usage: bun release [--dry-run]");
    return;
  }
  for (const arg of args) {
    if (arg !== "--dry-run") throw new Error(`Unknown argument: ${arg}`);
  }

  run("gh", ["auth", "status"]);
  run("git", ["fetch", "origin", "main", "--tags"]);

  const branch = run("git", ["branch", "--show-current"], { capture: true });
  const status = run("git", ["status", "--porcelain"], { capture: true });
  const head = run("git", ["rev-parse", "HEAD"], { capture: true });
  const remoteHead = run("git", ["rev-parse", "origin/main"], { capture: true });
  const latestTag = latestReleaseTag();
  run("git", ["rev-parse", "--verify", `${latestTag}^{commit}`], { capture: true });
  const commits = parseCommitLog(
    run("git", ["log", "--format=%H%x1f%s%x1f%b%x1e", `${latestTag}..${head}`], { capture: true })
  );
  const plan = createReleasePlan({ branch, commits, head, latestTag, remoteHead, status });

  if (plan.action === "noop") {
    if (!releaseAssetsAreComplete(latestTag)) {
      if (args.has("--dry-run")) {
        console.log(`Dry run complete; ${latestTag} requires a desktop asset repair.`);
        return;
      }
      withReleaseRunners(() => {
        dispatchReleaseAssets(latestTag);
        verifyReleaseAssets(latestTag);
      });
      cleanLocalReleaseState();
      console.log(`Release repaired with verified desktop assets: ${latestTag}`);
      return;
    }
    if (!args.has("--dry-run")) cleanLocalReleaseState();
    console.log(`No releasable commits exist after ${latestTag}; release is already current.`);
    return;
  }

  console.log(`Release needed after ${latestTag}:`);
  for (const commit of plan.releasableCommits) {
    console.log(`- ${commit.hash.slice(0, 8)} ${commit.subject}`);
  }
  if (args.has("--dry-run")) {
    console.log("Dry run complete; validation, release PR creation, and publication were skipped.");
    return;
  }

  for (const [command, commandArgs] of validationCommands) run(command, commandArgs);

  run("git", ["fetch", "origin", "main", "--tags"]);
  const validatedStatus = run("git", ["status", "--porcelain"], { capture: true });
  const validatedHead = run("git", ["rev-parse", "HEAD"], { capture: true });
  const validatedRemoteHead = run("git", ["rev-parse", "origin/main"], { capture: true });
  if (validatedStatus.trim()) {
    throw new Error(
      "Release validation changed tracked files; inspect the worktree before retrying."
    );
  }
  if (validatedHead !== head || validatedRemoteHead !== head) {
    throw new Error("main changed during release validation; update and rerun the preflight.");
  }

  const token = run("gh", ["auth", "token"], { capture: true });
  if (!token) throw new Error("GitHub CLI did not provide an authentication token.");
  runReleasePlease("release-pr", token);

  const releasePullRequests = findReleasePullRequests();
  if (releasePullRequests.length !== 1) {
    throw new Error(
      `Expected exactly one generated release pull request, found ${releasePullRequests.length}.`
    );
  }
  const releasePullRequest = releasePullRequests[0];
  run("npx", ["code-foundry", "release", "validate-prs"], {
    env: { ...process.env, GITHUB_REPOSITORY: repository },
  });
  if (releasePullRequest.isDraft) {
    run("gh", ["pr", "ready", String(releasePullRequest.number)]);
  }
  run("gh", [
    "pr",
    "merge",
    String(releasePullRequest.number),
    "--rebase",
    "--match-head-commit",
    releasePullRequest.headRefOid,
    "--delete-branch",
  ]);
  refreshMain();

  withReleaseRunners(() => {
    runReleasePlease("github-release", token);
    const releasedTag = latestReleaseTag();
    if (releasedTag === latestTag) {
      throw new Error(`Release Please completed without publishing a release after ${latestTag}.`);
    }
    run("git", ["fetch", "origin", "main", "--tags"]);
    const releaseSha = run("git", ["rev-parse", "--verify", `${releasedTag}^{commit}`], {
      capture: true,
    });
    waitForPublishedReleaseAssets(releasedTag, releaseSha);
    verifyReleaseAssets(releasedTag);
    console.log(`Release completed with verified desktop assets: ${releasedTag}`);
  });
  cleanLocalReleaseState();
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`manual-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
