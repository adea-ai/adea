import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const bun = process.execPath;

function run(label, command, args, cwd, timeoutMs = 180_000, env = process.env) {
  console.log(`\n[native-smoke] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    timeout: timeoutMs,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function androidEnvironment() {
  const java21Home = process.env.JAVA_HOME_21_X64;
  if (!java21Home || !existsSync(resolve(java21Home, "bin", "javac"))) {
    return process.env;
  }

  console.log(`[native-smoke] using Android JDK 21 at ${java21Home}`);
  return {
    ...process.env,
    JAVA_HOME: java21Home,
    PATH: `${resolve(java21Home, "bin")}:${process.env.PATH ?? ""}`,
  };
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function ensureLinuxDesktopDependencies() {
  if (process.platform !== "linux" || process.env.CI !== "true") return;

  const requiredPackages = [
    ["glib-2.0", "libwebkit2gtk-4.1-dev"],
    ["gtk+-3.0", "libwebkit2gtk-4.1-dev"],
    ["webkit2gtk-4.1", "libwebkit2gtk-4.1-dev"],
    ["javascriptcoregtk-4.1", "libwebkit2gtk-4.1-dev"],
    ["librsvg-2.0", "librsvg2-dev"],
  ];
  const missingPackages = requiredPackages
    .filter(([pkgConfigName]) => !commandAvailable("pkg-config", ["--exists", pkgConfigName]))
    .map(([, aptPackage]) => aptPackage)
    .filter((packageName, index, packages) => packages.indexOf(packageName) === index);

  if (missingPackages.length === 0) return;
  if (!commandAvailable("sudo", ["-n", "true"])) {
    throw new Error(
      `Linux desktop dependencies are missing (${missingPackages.join(", ")}) and passwordless sudo is unavailable`,
    );
  }

  run("install Linux desktop dependencies", "sudo", ["apt-get", "update"], repoRoot, 300_000);
  run(
    "install Linux desktop dependencies",
    "sudo",
    ["apt-get", "install", "-y", ...missingPackages, "libayatana-appindicator3-dev", "patchelf"],
    repoRoot,
    300_000,
  );
}

const desktopRoot = resolve(repoRoot, "apps/desktop");
const desktopRustRoot = resolve(desktopRoot, "src-tauri");
const mobileRoot = resolve(repoRoot, "apps/mobile");

run("desktop TypeScript smoke", bun, ["run", "typecheck"], desktopRoot);
ensureLinuxDesktopDependencies();
run(
  "desktop Tauri/Rust smoke",
  "cargo",
  ["check", "--locked", "--manifest-path", resolve(desktopRustRoot, "Cargo.toml")],
  repoRoot,
);
run("mobile TypeScript smoke", bun, ["run", "typecheck"], mobileRoot);
run("mobile Capacitor sync smoke", bun, ["run", "sync"], mobileRoot);

const strictNativeSmoke = process.env.NATIVE_SMOKE_STRICT === "1";
const androidRoot = resolve(mobileRoot, "android");
const iosRoot = resolve(mobileRoot, "ios");
const androidSdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const platformChecks = [
  {
    name: "android",
    root: androidRoot,
    available: existsSync(androidRoot),
    toolchainAvailable:
      existsSync(resolve(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew")) &&
      Boolean(androidSdkRoot && existsSync(androidSdkRoot)),
  },
  {
    name: "ios",
    root: iosRoot,
    available: existsSync(iosRoot),
    toolchainAvailable: commandAvailable("xcodebuild", ["-version"]),
  },
];

for (const platform of platformChecks) {
  if (!platform.available) {
    const message = `Capacitor ${platform.name} project is missing`;
    if (strictNativeSmoke) throw new Error(message);
    console.warn(`[native-smoke] ${message}; compiler smoke skipped.`);
  } else if (!platform.toolchainAvailable) {
    const message = `${platform.name} compiler toolchain is unavailable on this host`;
    if (strictNativeSmoke) throw new Error(message);
    console.warn(`[native-smoke] ${message}; compiler smoke skipped.`);
  }
}

if (platformChecks[0].available && platformChecks[0].toolchainAvailable) {
  run(
    "mobile Android compiler smoke",
    process.platform === "win32" ? "gradlew.bat" : "./gradlew",
    ["--no-daemon", "assembleDebug"],
    androidRoot,
    180_000,
    androidEnvironment(),
  );
}

if (platformChecks[1].available && platformChecks[1].toolchainAvailable) {
  run(
    "mobile iOS compiler smoke",
    "xcodebuild",
    [
      "-project",
      resolve(iosRoot, "App/App.xcodeproj"),
      "-scheme",
      "App",
      "-sdk",
      "iphoneos",
      "-destination",
      "generic/platform=iOS",
      "-configuration",
      "Debug",
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
      "-derivedDataPath",
      resolve(tmpdir(), "agent-hq-ios-derived-data"),
    ],
    repoRoot,
    300_000,
  );
}

console.log("[native-smoke] passed");
