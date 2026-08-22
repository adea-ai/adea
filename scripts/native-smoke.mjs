import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const bun = process.execPath;

function run(label, command, args, cwd) {
  console.log(`\n[native-smoke] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

const desktopRoot = resolve(repoRoot, "apps/desktop");
const desktopRustRoot = resolve(desktopRoot, "src-tauri");
const mobileRoot = resolve(repoRoot, "apps/mobile");

run("desktop TypeScript smoke", bun, ["run", "typecheck"], desktopRoot);
run(
  "desktop Tauri/Rust smoke",
  "cargo",
  ["check", "--locked", "--manifest-path", resolve(desktopRustRoot, "Cargo.toml")],
  repoRoot,
);
run("mobile TypeScript smoke", bun, ["run", "typecheck"], mobileRoot);
run("mobile Capacitor sync smoke", bun, ["run", "sync"], mobileRoot);

const nativePlatformDirectories = ["android", "ios"].filter((platform) =>
  existsSync(resolve(mobileRoot, platform)),
);
if (nativePlatformDirectories.length === 0) {
  console.warn(
    "[native-smoke] Capacitor platform projects are not checked in; typecheck and config sync passed, but Android/iOS compiler smoke is not available yet.",
  );
} else {
  console.log(
    `[native-smoke] platform projects present: ${nativePlatformDirectories.join(", ")}; platform compiler smoke remains a platform-toolchain concern.`,
  );
}

console.log("[native-smoke] passed");
