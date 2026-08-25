import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

const repository = "0xPlayerOne/agent-hq";
const runnerVersion = "2.336.0";
const root = resolve(import.meta.dirname, "..");
// The Actions runner prepends its bundled tools to PATH without shell-escaping the
// installation directory. Keep the runner beneath a path with no spaces so every
// workflow shell can start reliably.
const stateRoot = join(homedir(), ".local", "share", "agent-hq", "release-runner");
const macRunnerRoot = join(stateRoot, "macos-arm64");
const macRunnerPid = join(stateRoot, "macos-arm64.pid");
const macRunnerLog = join(stateRoot, "macos-arm64.log");
const macCargoTarget = join(stateRoot, "macos-cargo-target");
const legacyMacCargoTarget = join(
  macRunnerRoot,
  "_work",
  "agent-hq",
  "agent-hq",
  "apps",
  "desktop",
  "src-tauri",
  "target",
);
const linuxImage = `agent-hq-release-runner-linux-x64:${runnerVersion}`;
const linuxContainer = "agent-hq-release-runner-linux-x64";
const linuxCargoTargetVolume = "agent-hq-release-linux-cargo-target";
const runnerDeletionAttempts = 120;
const safeHost = hostname()
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-");
const macRunnerName = `agent-hq-release-macos-arm64-${safeHost}`;
const linuxRunnerName = `agent-hq-release-linux-x64-${safeHost}`;

function run(command, args, { capture = false, cwd = root, displayArgs = args } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout).trim() : "";
    throw new Error(
      `${command} ${displayArgs.join(" ")} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return capture ? result.stdout.trim() : "";
}

function succeeds(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: "ignore" }).status === 0;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function registrationToken() {
  return run(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/actions/runners/registration-token`,
      "--jq",
      ".token",
    ],
    { capture: true },
  );
}

function runnerStatus(name) {
  return run(
    "gh",
    [
      "api",
      `repos/${repository}/actions/runners`,
      "--paginate",
      "--jq",
      `.runners[] | select(.name == "${name}") | .status`,
    ],
    { capture: true },
  );
}

function runnerId(name) {
  return run(
    "gh",
    [
      "api",
      `repos/${repository}/actions/runners`,
      "--paginate",
      "--jq",
      `.runners[] | select(.name == "${name}") | .id`,
    ],
    { capture: true },
  );
}

function deleteRunnerRegistration(name) {
  for (let attempt = 0; attempt < runnerDeletionAttempts; attempt += 1) {
    const id = runnerId(name);
    if (!id) return;
    const result = spawnSync(
      "gh",
      ["api", "--method", "DELETE", `repos/${repository}/actions/runners/${id}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.error) throw result.error;
    if (result.status === 0) return;
    const detail = (result.stderr || result.stdout).trim();
    if (!detail.includes("currently running a job")) {
      throw new Error(`Could not delete runner ${name}: ${detail}`);
    }
    sleep(1_000);
  }
  throw new Error(`Timed out deleting the busy runner registration ${name}.`);
}

function waitForRunner(name) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (runnerStatus(name) === "online") return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  }
  throw new Error(`Timed out waiting for ${name} to become online.`);
}

function processGroupIsAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureMacRunner() {
  mkdirSync(macRunnerRoot, { recursive: true });
  if (!existsSync(join(macRunnerRoot, "config.sh"))) {
    const archive = join(stateRoot, `actions-runner-osx-arm64-${runnerVersion}.tar.gz`);
    run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      `https://github.com/actions/runner/releases/download/v${runnerVersion}/actions-runner-osx-arm64-${runnerVersion}.tar.gz`,
      "--output",
      archive,
    ]);
    const digest = run("shasum", ["--algorithm", "256", archive], { capture: true }).split(" ")[0];
    if (digest !== "8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079") {
      throw new Error("The downloaded macOS Actions runner archive failed checksum verification.");
    }
    run("tar", ["-xzf", archive, "-C", macRunnerRoot]);
  }
  if (!existsSync(join(macRunnerRoot, ".runner"))) {
    run(
      "./config.sh",
      [
        "--unattended",
        "--replace",
        "--url",
        `https://github.com/${repository}`,
        "--token",
        registrationToken(),
        "--name",
        macRunnerName,
        "--labels",
        "agent-hq-release-macos-arm64",
        "--work",
        "_work",
      ],
      {
        cwd: macRunnerRoot,
        displayArgs: ["--unattended", "--replace", "--url", `https://github.com/${repository}`],
      },
    );
  }
}

function startMacRunner() {
  ensureMacRunner();
  if (!existsSync(macCargoTarget) && existsSync(legacyMacCargoTarget)) {
    renameSync(legacyMacCargoTarget, macCargoTarget);
  }
  mkdirSync(macCargoTarget, { recursive: true });
  if (existsSync(macRunnerPid)) {
    const pid = Number(readFileSync(macRunnerPid, "utf8"));
    if (processGroupIsAlive(pid)) {
      waitForRunner(macRunnerName);
      return;
    }
  }
  const log = openSync(macRunnerLog, "a");
  const child = spawn(join(macRunnerRoot, "run.sh"), [], {
    cwd: macRunnerRoot,
    detached: true,
    env: { ...process.env, CARGO_TARGET_DIR: macCargoTarget },
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
  writeFileSync(macRunnerPid, `${child.pid}\n`, { mode: 0o600 });
  waitForRunner(macRunnerName);
}

function startLinuxRunner() {
  run("docker", [
    "build",
    "--quiet",
    "--platform",
    "linux/amd64",
    "--tag",
    linuxImage,
    join(root, ".github", "release-runner", "linux-x64"),
  ]);
  if (succeeds("docker", ["container", "inspect", linuxContainer])) {
    waitForRunner(linuxRunnerName);
    return;
  }
  const token = registrationToken();
  const dockerArgs = [
    "run",
    "--detach",
    "--rm",
    "--platform",
    "linux/amd64",
    "--name",
    linuxContainer,
    "--mount",
    `type=volume,source=${linuxCargoTargetVolume},target=/home/runner/cache/cargo-target`,
    "--env",
    `RUNNER_NAME=${linuxRunnerName}`,
    "--env",
    `RUNNER_TOKEN=${token}`,
    linuxImage,
  ];
  run("docker", dockerArgs, {
    displayArgs: dockerArgs.map((arg) =>
      arg.startsWith("RUNNER_TOKEN=") ? "RUNNER_TOKEN=***" : arg,
    ),
  });
  waitForRunner(linuxRunnerName);
}

function start() {
  try {
    startMacRunner();
    startLinuxRunner();
    console.log("Local Agent HQ release runners are online.");
  } catch (error) {
    try {
      stop();
    } catch (cleanupError) {
      console.error(
        `release-runners: cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

function stop() {
  let cleanupError;
  if (succeeds("docker", ["container", "inspect", linuxContainer])) {
    run("docker", ["stop", "--timeout", "5", linuxContainer]);
  }
  try {
    deleteRunnerRegistration(linuxRunnerName);
  } catch (error) {
    cleanupError = error;
  }
  if (existsSync(macRunnerPid)) {
    const pid = Number(readFileSync(macRunnerPid, "utf8"));
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The runner process group already stopped.
    }
    for (let attempt = 0; attempt < 30 && processGroupIsAlive(pid); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    }
    if (processGroupIsAlive(pid)) {
      throw new Error(`Timed out stopping the macOS release runner process group ${pid}.`);
    }
    unlinkSync(macRunnerPid);
  }
  if (cleanupError) throw cleanupError;
  console.log("Local Agent HQ release runners are stopped.");
}

const command = process.argv[2];
if (command === "start") start();
else if (command === "stop") stop();
else throw new Error("Usage: bun scripts/release-runners.mjs <start|stop>");
