// Proves an output directory carries no auth fixture code. The production build runs
// it on dist and it must report "absent" (exit 0). With --expect-present it inverts:
// it passes only when the directory carries the fixture markers.
import { resolve } from 'node:path'
import { findFixtureMarkers } from './auth-fixture-markers.mjs'

const target = resolve(process.argv[2] ?? 'dist')
const expectPresent = process.argv.includes('--expect-present')
const hits = await findFixtureMarkers(target)
const present = hits.length > 0
console.log(
  JSON.stringify(
    present
      ? { directory: target, status: 'present', hits }
      : { directory: target, status: 'absent' }
  )
)
process.exitCode = present === expectPresent ? 0 : 1
