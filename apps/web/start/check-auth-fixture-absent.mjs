// Proves an output directory carries no auth fixture code. Run it on the production
// build; it must report "absent" and exit 0. On the fixture build it reports "present".
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const markers = ['ADEA_AUTH_FIXTURE_OUTBOX_URL', 'fixture transport refusal', 'fixture outbox']
const target = resolve(process.argv[2] ?? 'dist')

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if ((await stat(path)).isFile()) yield path
  }
}

const hits = []
for await (const file of files(target)) {
  const text = await readFile(file, 'utf8').catch(() => '')
  for (const marker of markers) if (text.includes(marker)) hits.push(`${file}: ${marker}`)
}
if (hits.length > 0) {
  console.log(JSON.stringify({ directory: target, status: 'present', hits }))
  process.exitCode = process.argv.includes('--expect-present') ? 0 : 1
} else {
  console.log(JSON.stringify({ directory: target, status: 'absent' }))
  process.exitCode = process.argv.includes('--expect-present') ? 1 : 0
}
