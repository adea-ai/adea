import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import { buildTasks } from './scripts/orch-graph.mjs'
import { expectedId } from './scripts/orch-toolchain.mjs'

// Task graph for `vp run`: `build`, `typecheck`, `lint` and `test` over every workspace, generated from the package
// manifests (scripts/orch-graph.mjs). The root `package.json` scripts call the aggregates (`orch:build`,
// `orch:typecheck`, `orch:lint`, `orch:test`); each task runs the package's own script, so Bun still runs the tests.
// Names are prefixed because a task may not share a name with a root script.
const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  run: {
    tasks: buildTasks(root, expectedId(root)),
  },
})
