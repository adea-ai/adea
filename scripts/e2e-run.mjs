import { spawnSync } from 'node:child_process'
import { runE2ePreparation } from './e2e-preparation.mjs'

await runE2ePreparation()

const result = spawnSync('bun', ['scripts/e2e-playwright.mjs'], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) {
  const reason =
    result.status === null ? `signal ${result.signal ?? 'unknown'}` : `exit code ${result.status}`
  throw new Error(`bun scripts/e2e-playwright.mjs failed with ${reason}`)
}
