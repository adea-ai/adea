import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Replace a local Wrangler config in one same-directory rename. */
export async function writeLocalWorkerConfig(path, value) {
  const target = resolve(path)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}
