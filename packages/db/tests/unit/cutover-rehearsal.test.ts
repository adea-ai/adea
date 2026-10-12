import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { disposeRehearsal } from '../fixtures/cutover-rehearsal'

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
})
