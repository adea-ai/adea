// Agent Sim is hosted separately. Keep this former staging entry as a hard
// migration guard so an old release environment cannot silently reintroduce
// licensed engine bytes into a public or desktop client build.
import { fileURLToPath } from 'node:url'
import { existsSync, realpathSync } from 'node:fs'

export async function packFromEnv({ log = console.log, environment = process.env } = {}) {
  if (environment.ADEA_AGENT_SIM_DIST) {
    throw new Error(
      'Agent Sim is hosted separately; ADEA_AGENT_SIM_DIST is no longer a client build input.'
    )
  }
  log('Agent Sim is hosted separately; client assets contain scene manifests only.')
  return false
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  packFromEnv().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
