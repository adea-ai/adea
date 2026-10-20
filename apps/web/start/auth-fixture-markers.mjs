// Strings that only the auth fixture build can contain. The production artifact
// check and the fixture acceptance harness both read them from here, so the two
// cannot drift apart.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const fixtureMarkers = [
  'ADEA_AUTH_FIXTURE_OUTBOX_URL',
  'fixture transport refusal',
  'fixture outbox',
]

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if ((await stat(path)).isFile()) yield path
  }
}

// Returns one "file: marker" entry per hit; an empty list means no fixture code.
export async function findFixtureMarkers(directory) {
  const hits = []
  for await (const file of files(directory)) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const marker of fixtureMarkers) if (text.includes(marker)) hits.push(`${file}: ${marker}`)
  }
  return hits
}
