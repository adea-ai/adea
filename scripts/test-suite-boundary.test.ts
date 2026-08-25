import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("test suite boundaries", () => {
  test("exposes Code Foundry entry points for every test category", () => {
    expect(packageJson.scripts.test).toBe("bun run test:unit");
    expect(packageJson.scripts["test:unit"]).toContain("turbo run test");
    expect(packageJson.scripts["test:unit"]).toContain("bun run test:coverage");
    expect(packageJson.scripts["test:integration"]).toBe("bun test packages/*/tests/integration");
    expect(packageJson.scripts["test:e2e"]).toContain("playwright");
    const playwrightConfig = readFileSync(resolve(root, "playwright.config.ts"), "utf8");
    expect(playwrightConfig).toContain('"--use-angle=metal"');
    expect(playwrightConfig).toContain('headless: process.platform !== "darwin"');
    expect(packageJson.scripts["test:smoke"]).toBe("bun run native:smoke");
    expect(packageJson.scripts.release).toBe("bun scripts/manual-release.mjs");
    expect(packageJson.scripts["release:manual"]).toBeUndefined();
  });

  test("keeps smoke validation independent from the build lane", () => {
    expect(packageJson.scripts.build).not.toContain("native:smoke");
  });

  test("enforces the repository coverage goal on durable core code", () => {
    expect(packageJson.scripts["test:coverage"]).toBe(
      "bun test packages/auth/tests/unit packages/db/tests/unit scripts/*.test.ts --coverage",
    );

    const bunfig = readFileSync(resolve(root, "bunfig.toml"), "utf8");
    expect(bunfig).toContain("coverageThreshold = { line = 0.8, function = 0.8 }");
    expect(bunfig).toContain("coverageSkipTestFiles = true");
    expect(bunfig).toContain('coverageReporter = ["text", "lcov"]');
    expect(bunfig).toContain('coverageDir = "coverage"');

    const codeFoundry = readFileSync(resolve(root, ".github/code-foundry.yml"), "utf8");
    expect(codeFoundry).toContain("coverage_minimum: 80");
  });

  test("runs the database-backed integration category in the Neon lane", () => {
    const neonWorkflow = readFileSync(resolve(root, ".github/workflows/neon_workflow.yml"), "utf8");
    expect(neonWorkflow).toContain("bun run test:integration");
    expect(neonWorkflow).not.toContain("packages/db test:integration");
    expect(neonWorkflow).not.toContain("packages/auth test:integration");
  });

  test("keeps Release Please local while allowing the asset workflow to run anywhere", () => {
    const manualRelease = readFileSync(resolve(root, "scripts/manual-release.mjs"), "utf8");
    expect(manualRelease).toContain('runReleasePlease("release-pr"');
    expect(manualRelease).toContain('runReleasePlease("github-release"');
    expect(manualRelease).toContain("GITHUB_REPOSITORY: repository");
    expect(manualRelease).toContain('"workflow", "run", "release-assets.yml"');
  });

  test("routes paused desktop releases to this machine's self-hosted runners", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release-assets.yml"), "utf8");
    const runnerScript = readFileSync(resolve(root, "scripts/release-runners.mjs"), "utf8");
    expect(workflow).toContain("agent-hq-release-macos-arm64");
    expect(workflow).toContain("agent-hq-release-linux-x64");
    expect(workflow).toContain("cargo-xwin");
    expect(workflow).toContain("rustup target add x86_64-pc-windows-msvc");
    expect(workflow).toContain("--bundles nsis");
    expect(workflow).toContain("bun scripts/release-notes.mjs");
    expect(workflow).toContain("bun run --cwd packages/types build");
    expect(workflow).toContain("timeout_minutes: 120");
    expect(workflow).toContain("timeout-minutes: ${{ matrix.timeout_minutes }}");
    expect(workflow).toContain("id: desktop_bundle");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("steps.desktop_bundle.outcome == 'failure'");
    expect(workflow).toContain("Retry desktop bundle upload");
    expect(workflow).toContain("name: desktop-updater-pages");
    expect(workflow).not.toContain("name: github-pages");
    expect(workflow).toContain("vars.CI_BILLING_PAUSED == 'true'");
    expect(workflow).not.toContain("if: vars.CI_BILLING_PAUSED != 'true'");
    expect(runnerScript).toContain('join(homedir(), ".local", "share", "agent-hq"');
    expect(runnerScript).not.toContain('"Application Support"');
    expect(runnerScript).toContain("agent-hq-release-linux-cargo-target");

    const linuxRunner = readFileSync(
      resolve(root, ".github/release-runner/linux-x64/Dockerfile"),
      "utf8",
    );
    expect(linuxRunner).toContain("sudo unzip xdg-utils xz-utils");
    expect(linuxRunner).toContain("ENV CARGO_BUILD_JOBS=1");
    expect(linuxRunner).toContain("ENV CARGO_TARGET_DIR=/home/runner/cache/cargo-target");
    expect(linuxRunner).toContain("squashfs-tools");
    expect(linuxRunner).toContain("extract_appimage");
    expect(linuxRunner).toContain("LINUXDEPLOY_PLUGIN_APPIMAGE_SHA256");
    expect(linuxRunner).toContain("linuxdeploy-x86_64.AppImage.real");
    expect(linuxRunner).toContain("linuxdeploy-plugin-appimage.AppImage.real");
    expect(linuxRunner).toContain("appimage-wrapper.c");
    expect(linuxRunner).toContain("cc -O2 -Wall -Wextra -Werror");

    const appImageWrapper = readFileSync(
      resolve(root, ".github/release-runner/linux-x64/appimage-wrapper.c"),
      "utf8",
    );
    expect(appImageWrapper).toContain('setenv("APPIMAGE", executable');
    expect(appImageWrapper).toContain('setenv("APPDIR", appdir');
    expect(appImageWrapper).toContain("execv(apprun, argv)");
  });

  test("does not report a release before its desktop assets finish", () => {
    const manualRelease = readFileSync(resolve(root, "scripts/manual-release.mjs"), "utf8");
    expect(manualRelease).toContain("waitForPublishedReleaseAssets");
    expect(manualRelease).toContain("waitForWorkflowRun");
    expect(manualRelease).toContain("Release status check failed; retrying");
    expect(manualRelease).toContain("const workflowWaitAttempts = 900");
    expect(manualRelease).toContain("attempt < workflowWaitAttempts");
    expect(manualRelease).toContain("verifyReleaseAssets");
    expect(manualRelease).toContain("releaseAssetsAreComplete");
    expect(manualRelease).toContain("dispatchReleaseAssets");

    const runnerScript = readFileSync(resolve(root, "scripts/release-runners.mjs"), "utf8");
    expect(runnerScript).toContain("deleteRunnerRegistration");
    expect(runnerScript).toContain("currently running a job");
    expect(runnerScript).toContain("const runnerDeletionAttempts = 120");
    expect(runnerScript).toContain("attempt < runnerDeletionAttempts");
  });

  test("keeps one canonical changelog and versions every private workspace in lockstep", () => {
    const releaseConfig = JSON.parse(
      readFileSync(resolve(root, "release-please-config.json"), "utf8"),
    );
    const extraFiles = new Set(
      releaseConfig["extra-files"].map((entry: { path: string }) => entry.path),
    );
    const cargoLockUpdater = releaseConfig["extra-files"].find(
      (entry: { path: string }) => entry.path === "apps/desktop/src-tauri/Cargo.lock",
    );
    const tauriConfig = JSON.parse(
      readFileSync(resolve(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    );

    expect(tauriConfig.version).toBe("../package.json");
    expect(extraFiles.has("apps/desktop/src-tauri/tauri.conf.json")).toBeFalse();
    expect(cargoLockUpdater).toEqual({
      type: "toml",
      path: "apps/desktop/src-tauri/Cargo.lock",
      jsonpath: "$.package[?(@.name.value=='agent-hq-desktop')].version",
    });

    for (const workspaceGroup of ["apps", "packages", "scenes"]) {
      for (const workspace of readdirSync(resolve(root, workspaceGroup))) {
        const packagePath = `${workspaceGroup}/${workspace}/package.json`;
        if (!existsSync(resolve(root, packagePath))) continue;
        expect(extraFiles.has(packagePath)).toBeTrue();
        expect(existsSync(resolve(root, workspaceGroup, workspace, "CHANGELOG.md"))).toBeFalse();
      }
    }
  });
});
