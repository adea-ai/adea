import { spawnSync } from "node:child_process";

import { createTauriCloudConfig, normalizeDesktopCloudOrigin } from "./tauri-cloud-config.mjs";

const [command, ...arguments_] = process.argv.slice(2);
if (command !== "build" && command !== "dev") {
  throw new Error("Desktop Tauri wrapper requires the build or dev command");
}

const cloudOrigin = normalizeDesktopCloudOrigin(
  process.env.VITE_ADEA_CLOUD_ORIGIN ?? process.env.ADEA_CLOUD_ORIGIN
);
const environment = {
  ...process.env,
  ADEA_CLOUD_ORIGIN: cloudOrigin,
  VITE_ADEA_CLOUD_ORIGIN: cloudOrigin,
};
const result = spawnSync(
  process.execPath,
  [
    "x",
    "tauri",
    command,
    ...arguments_,
    "--config",
    JSON.stringify(createTauriCloudConfig(cloudOrigin)),
  ],
  { env: environment, stdio: "inherit" }
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
