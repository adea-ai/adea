import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { disposeRehearsal, type RehearsalResources } from '../fixtures/cutover-rehearsal'

function failConnectionConstruction(): never {
  throw new Error('connection construction failed')
}

describe('cutover rehearsal cleanup', () => {
  test('a throwing close still drops the owned database and removes the temporary folder', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'rehearsal-cleanup-'))
    const steps: string[] = []

    await expect(
      disposeRehearsal(
        {
          connection: {
            async close() {
              steps.push('close')
              throw new Error('close failed')
            },
          },
          scratch: 'rehearsal_owned_test_db',
          preFolder: folder,
        },
        async (database) => {
          steps.push(`drop:${database}`)
        }
      )
    ).rejects.toThrow('rehearsal cleanup failed in 1 step(s)')

    expect(steps).toEqual(['close', 'drop:rehearsal_owned_test_db'])
    expect(existsSync(folder)).toBe(false)
  })

  test('a connection-construction failure still drops a database recorded before construction', async () => {
    const database = 'rehearsal_owned_constructor_failure'
    const resources: RehearsalResources = { scratch: database }
    const dropped: string[] = []

    await expect(
      (async () => {
        try {
          resources.connection = failConnectionConstruction()
        } finally {
          await disposeRehearsal(resources, async (scratch) => {
            dropped.push(scratch)
          })
        }
      })()
    ).rejects.toThrow('connection construction failed')

    expect(dropped).toEqual([database])
  })
})
