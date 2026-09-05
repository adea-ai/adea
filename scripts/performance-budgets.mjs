import { readFile } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const DEFAULT_PERFORMANCE_BUDGETS = {
  routeFirstLoadJsBytes: { "/": 700_000 },
  // Room-designer catalog growth (2,400+ interior models) intentionally
  // exceeds the original 160MB waterline. Keep headroom tight so accidental
  // bloat still trips the gate.
  publicAssetBytes: 350_000_000,
  sceneLoadMs: 10_000,
  sceneTransferBytes: 35_000_000,
  runtimeP95FrameMs: 30,
};

export function routeBundleStatsFromNextReport(report) {
  return {
    routes: (report.routes ?? []).map((route) => ({
      route: route.route,
      firstLoadUncompressedJsBytes: route.clientJs?.bytes ?? 0,
    })),
  };
}

export function checkStaticBudgets(measurements, budgets = DEFAULT_PERFORMANCE_BUDGETS) {
  const failures = [];
  for (const [route, budget] of Object.entries(budgets.routeFirstLoadJsBytes ?? {})) {
    const routeMeasurement = measurements.routes?.find((entry) => entry.route === route);
    if (!routeMeasurement) {
      failures.push(`missing route bundle measurement for ${route}`);
      continue;
    }
    if (routeMeasurement.firstLoadUncompressedJsBytes > budget) {
      failures.push(
        `route ${route} first-load JavaScript is ${routeMeasurement.firstLoadUncompressedJsBytes} bytes (budget ${budget})`
      );
    }
  }
  if (measurements.publicAssetBytes > budgets.publicAssetBytes) {
    failures.push(
      `public assets are ${measurements.publicAssetBytes} bytes (budget ${budgets.publicAssetBytes})`
    );
  }
  return failures;
}

export function checkRuntimeReports(reports, budgets = DEFAULT_PERFORMANCE_BUDGETS) {
  const failures = [];
  const sceneEvents = new Map();
  for (const report of reports) {
    const scene = report.scene ?? "unknown scene";
    const events = sceneEvents.get(scene) ?? new Set();
    events.add(report.event);
    sceneEvents.set(scene, events);
    if (report.event === "error") {
      failures.push(`${scene} emitted error: ${report.error ?? "unknown error"}`);
      continue;
    }
    if (report.event === "load") {
      const loadMs = report.milestones?.playableCharacterMs;
      if (typeof loadMs === "number" && loadMs > budgets.sceneLoadMs) {
        failures.push(
          `${scene} playable scene time is ${loadMs}ms (budget ${budgets.sceneLoadMs})`
        );
      }
    }
    const p95FrameMs = report.runtime?.p95FrameMs;
    if (typeof p95FrameMs === "number" && p95FrameMs > budgets.runtimeP95FrameMs) {
      failures.push(
        `${scene} p95 frame time is ${p95FrameMs}ms (budget ${budgets.runtimeP95FrameMs})`
      );
    }
  }
  for (const [scene, events] of sceneEvents) {
    if (!events.has("load") && !events.has("error")) {
      failures.push(`${scene} is missing a load performance report`);
    }
    if (!events.has("runtime") && !events.has("error")) {
      failures.push(`${scene} is missing a runtime performance report`);
    }
    const sceneReports = reports.filter((report) => report.scene === scene);
    const transferBytes = Math.max(
      ...sceneReports
        .filter((report) => report.event === "load" || report.event === "runtime")
        .map((report) => report.network?.transferBytes)
        .filter((value) => typeof value === "number"),
      0
    );
    if (transferBytes > budgets.sceneTransferBytes) {
      failures.push(
        `${scene} asset transfer is ${transferBytes} bytes (budget ${budgets.sceneTransferBytes})`
      );
    }
  }
  return failures;
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else total += (await stat(path)).size;
  }
  return total;
}

function parseArgs(args) {
  const options = { build: false, assets: false, runtime: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--build") options.build = true;
    else if (argument === "--assets") options.assets = true;
    else if (argument === "--runtime") options.runtime = args[++index];
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

async function readRouteMeasurements() {
  const legacyStatsPath = resolve("apps/web/.next/diagnostics/route-bundle-stats.json");
  try {
    return JSON.parse(await readFile(legacyStatsPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const result = spawnSync(
    "bun",
    ["run", "--cwd", "apps/web", "next", "internal", "static-routes-info", "--json"],
    { cwd: resolve("."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Unable to collect Next.js route bundle measurements (exit code ${result.status})`
    );
  }
  return routeBundleStatsFromNextReport(JSON.parse(result.stdout));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const failures = [];
  if (options.build || options.assets) {
    const measurements = {
      routes: options.build ? (await readRouteMeasurements()).routes : [],
      publicAssetBytes: options.assets ? await directoryBytes("apps/web/public/assets") : 0,
    };
    failures.push(...checkStaticBudgets(measurements));
  }
  if (options.runtime) {
    const value = JSON.parse(await readFile(options.runtime, "utf8"));
    const reports = Array.isArray(value) ? value : value.report ? [value.report] : [];
    failures.push(...checkRuntimeReports(reports));
  }
  if (!options.build && !options.assets && !options.runtime) {
    throw new Error("Provide --build, --assets, or --runtime <report.json>");
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`Performance budget failed: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Performance budgets passed.");
}

if (import.meta.main) await main();
