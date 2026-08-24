import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { createReleasePlan, parseCommitLog } from "./manual-release-core.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseHeadPrefix = "release-please--branches--main";
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

function run(command, args, { capture = false } = {}) {
  if (!capture) console.log(`\n$ ${[command, ...args].map(quote).join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout).trim() : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return capture ? result.stdout.trim() : "";
}

function runJson(command, args) {
  const output = run(command, args, { capture: true });
  return output ? JSON.parse(output) : null;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function listManualRuns() {
  return runJson("gh", [
    "run",
    "list",
    "--workflow",
    "release.yml",
    "--event",
    "workflow_dispatch",
    "--branch",
    "main",
    "--limit",
    "20",
    "--json",
    "databaseId,headSha,status,conclusion",
  ]);
}

async function dispatchReleaseWorkflow(expectedHead) {
  const previousRuns = new Set(listManualRuns().map((item) => item.databaseId));
  run("gh", [
    "workflow",
    "run",
    "release.yml",
    "--ref",
    "main",
    "--field",
    "release-while-paused=true",
  ]);

  let releaseRun;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(2_000);
    releaseRun = listManualRuns().find(
      (item) => item.headSha === expectedHead && !previousRuns.has(item.databaseId),
    );
    if (releaseRun) break;
  }
  if (!releaseRun) throw new Error("Timed out waiting for the manual release workflow run.");

  run("gh", ["run", "watch", String(releaseRun.databaseId), "--exit-status"]);
  return releaseRun.databaseId;
}

function latestReleaseTag() {
  return run("gh", ["release", "view", "--json", "tagName", "--jq", ".tagName"], {
    capture: true,
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
      pullRequest.title.startsWith("chore(main): release "),
  );
}

function refreshMain() {
  run("git", ["fetch", "origin", "main", "--tags"]);
  run("git", ["merge", "--ff-only", "origin/main"]);
  return run("git", ["rev-parse", "HEAD"], { capture: true });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log("Usage: bun run release:manual [--dry-run]");
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
    run("git", ["log", "--format=%H%x1f%s%x1f%b%x1e", `${latestTag}..${head}`], { capture: true }),
  );
  const plan = createReleasePlan({ branch, commits, head, latestTag, remoteHead, status });

  if (plan.action === "noop") {
    console.log(`No releasable commits exist after ${latestTag}; release is already current.`);
    return;
  }

  console.log(`Release needed after ${latestTag}:`);
  for (const commit of plan.releasableCommits) {
    console.log(`- ${commit.hash.slice(0, 8)} ${commit.subject}`);
  }
  if (args.has("--dry-run")) {
    console.log("Dry run complete; validation, workflow dispatch, and merge were skipped.");
    return;
  }

  for (const [command, commandArgs] of validationCommands) run(command, commandArgs);

  await dispatchReleaseWorkflow(head);
  if (latestReleaseTag() !== latestTag) {
    const releasedTag = latestReleaseTag();
    refreshMain();
    console.log(`Release completed: ${releasedTag}`);
    return;
  }

  run("git", ["fetch", "origin", "main", "--tags"]);
  let nextHead = run("git", ["rev-parse", "origin/main"], { capture: true });
  if (nextHead === head) {
    const releasePullRequests = findReleasePullRequests();
    if (releasePullRequests.length !== 1) {
      throw new Error(
        `Expected exactly one generated release pull request, found ${releasePullRequests.length}.`,
      );
    }
    const releasePullRequest = releasePullRequests[0];
    run("npx", ["code-foundry", "release", "validate-prs"]);
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
    nextHead = refreshMain();
  } else {
    nextHead = refreshMain();
  }

  await dispatchReleaseWorkflow(nextHead);
  const releasedTag = latestReleaseTag();
  if (releasedTag === latestTag) {
    throw new Error(`Release workflow completed without publishing a release after ${latestTag}.`);
  }
  run("git", ["fetch", "origin", "main", "--tags"]);
  run("git", ["rev-parse", "--verify", `${releasedTag}^{commit}`], { capture: true });
  console.log(`Release completed: ${releasedTag}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`manual-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
