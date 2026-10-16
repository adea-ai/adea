// Release gate: the build target recorded inside a packaged bundle must be the
// release build for the canonical hosted origin. A bundle built any other way
// (a local `shell:build`, a hosted-dev build) would ship a client that talks to
// the wrong cloud. Reads the recorded target on stdin.
import { DEFAULT_CLOUD_ORIGIN, parseDesktopTarget } from './cloud-config.mjs'

export function assertReleaseTarget(text) {
  const target = parseDesktopTarget(text)
  if (target.mode !== 'release' || target.cloudOrigin !== DEFAULT_CLOUD_ORIGIN) {
    throw new Error(
      `The packaged client was built as ${target.mode} for ${target.cloudOrigin}, not as a release build for ${DEFAULT_CLOUD_ORIGIN}`
    )
  }
  return target
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  try {
    const target = assertReleaseTarget(Buffer.concat(chunks).toString('utf8'))
    console.log(`Packaged client target verified: ${target.mode} build for ${target.cloudOrigin}.`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
