import { readFile } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_PERFORMANCE_BUDGETS = {
  routeFirstLoadJsBytes: { "/": 600_000 },
  publicAssetBytes: 160_000_000,
  sceneLoadMs: 10_000,
  sceneTransferBytes: 35_000_000,
  runtimeP95FrameMs: 30,
};

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
        `route ${route} first-load JavaScript is ${routeMeasurement.firstLoadUncompressedJsBytes} bytes (budget ${budget})`,
      );
    }
  }
  if (measurements.publicAssetBytes > budgets.publicAssetBytes) {
    failures.push(
      `public assets are ${measurements.publicAssetBytes} bytes (budget ${budgets.publicAssetBytes})`,
    );
  }
  return failures;
}

export function checkRuntimeReports(reports, budgets = DEFAULT_PERFORMANCE_BUDGETS) {
  const failures = [];
  for (const report of reports) {
    const scene = report.scene ?? "unknown scene";
    if (report.event === "error") {
      failures.push(`${scene} emitted error: ${report.error ?? "unknown error"}`);
      continue;
    }
    if (report.event === "load") {
      const loadMs = report.milestones?.playableCharacterMs;
      if (typeof loadMs === "number" && loadMs > budgets.sceneLoadMs) {
        failures.push(
          `${scene} playable scene time is ${loadMs}ms (budget ${budgets.sceneLoadMs})`,
        );
      }
      const transferBytes = report.network?.transferBytes;
      if (typeof transferBytes === "number" && transferBytes > budgets.sceneTransferBytes) {
        failures.push(
          `${scene} asset transfer is ${transferBytes} bytes (budget ${budgets.sceneTransferBytes})`,
        );
      }
    }
    const p95FrameMs = report.runtime?.p95FrameMs;
    if (typeof p95FrameMs === "number" && p95FrameMs > budgets.runtimeP95FrameMs) {
      failures.push(
        `${scene} p95 frame time is ${p95FrameMs}ms (budget ${budgets.runtimeP95FrameMs})`,
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const failures = [];
  if (options.build || options.assets) {
    const measurements = {
      routes: options.build
        ? JSON.parse(await readFile("apps/web/.next/diagnostics/route-bundle-stats.json", "utf8"))
        : [],
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
