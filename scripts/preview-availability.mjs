import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { PREVIEW_SELECTION, previewEnv } from '../apps/web/cloudflare.config.ts'

// Decides, before any Cloudflare credential is in play, which of three outcomes a pull-request
// Preview run has. The rules are `previewEnv`'s own, not a copy:
//
//   unavailable  no ADEA_PREVIEW_* value is set. There are no isolated preview resources, so the
//                deploy step is not attempted. This is a state, not a validation result.
//   configured   every value is set and `previewEnv` accepts all of them. The deploy job runs
//                unchanged and any failure it has is a real failure.
//   (throws)     a partial, production-valued or non-preview selection. `previewEnv` throws, so
//                the job fails. A broken configuration is never reported as unavailable.
export function classifyPreviewAvailability(source = process.env) {
  const names = Object.values(PREVIEW_SELECTION)
  const selected = names.filter((name) => source[name]?.trim())
  if (selected.length === 0) return 'unavailable'
  previewEnv(source)
  return 'configured'
}

const SUMMARIES = {
  unavailable:
    '### Preview deployment intentionally unavailable\n\n' +
    'No isolated preview resources are configured (`' +
    Object.values(PREVIEW_SELECTION).join('`, `') +
    '` are all unset), so no preview Worker is deployed from this pull request and no ' +
    'Cloudflare credential is used. This is a deliberate state, not a validation failure. Worker ' +
    'build validation and the configuration and guard checks still run in the `unavailable` job.',
  configured:
    '### Isolated preview resources are selected\n\n' +
    'The selection passed validation. The deploy job runs unchanged; its result is a real ' +
    'deployment result.',
}

function main() {
  let state
  try {
    state = classifyPreviewAvailability()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`::error title=Preview configuration invalid::${message}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Preview configuration invalid\n\n${message}\n`
      )
    }
    process.exit(1)
  }
  console.log(`Preview availability: ${state}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${SUMMARIES[state]}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
