// Runs one command with the throwaway capture provisioning instance supplied, the way the canonical
// integration lane supplies it. Package scripts that run integration tests directly call this, so the
// migration-snapshot capture proofs and the clean-destination restore tests find
// MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL instead of failing on its absence.
//
//   node scripts/run-with-capture-provisioning.mjs -- <command> [args...]
//
// Only the capture variable is added. DATABASE_URL and DATABASE_MIGRATION_URL pass through unchanged, so
// the application and migration roles keep their separate boundaries. Without Docker the command runs
// without the variable: the tests that require it fail with their own message rather than skipping. The
// command's exit status is returned, and the instance is removed on success and on failure.
import { spawnSync } from 'node:child_process'

import {
  captureProvisioningDatabaseUrlVariable,
  startCaptureProvisioning,
} from './capture-provisioning.mjs'

// Node keeps the `--` separator in argv and Bun removes it, so both forms are accepted.
const rest = process.argv.slice(2)
const command = rest[0] === '--' ? rest.slice(1) : rest
if (command.length === 0) {
  console.error('usage: node scripts/run-with-capture-provisioning.mjs -- <command> [args...]')
  process.exit(2)
}

let provisioning = null
let status = 1
try {
  provisioning = startCaptureProvisioning((handle) => {
    provisioning = handle
  })
  const environment = { ...process.env }
  if (provisioning) {
    environment[captureProvisioningDatabaseUrlVariable] = provisioning.databaseUrl
  } else {
    console.warn(
      `Docker is unavailable; ${captureProvisioningDatabaseUrlVariable} is not provisioned`
    )
  }
  const result = spawnSync(command[0], command.slice(1), { env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  status = result.status ?? 1
} catch (error) {
  console.error(error.message)
  status = 1
} finally {
  if (provisioning) {
    try {
      provisioning.stop()
    } catch (error) {
      console.error(`removing the capture provisioning container failed: ${error.message}`)
      status = 1
    }
  }
}
process.exit(status)
