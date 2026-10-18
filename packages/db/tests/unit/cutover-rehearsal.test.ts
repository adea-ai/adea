import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  disposeRehearsal,
  isProductDenial,
  view,
  PRODUCT_DENIALS,
  migrationsFolderBefore,
  readJournal,
  DRIZZLE_DIR,
  CUTOVER_TAG,
  settleAndDispose,
  type RehearsalResources,
} from '../fixtures/cutover-rehearsal'

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

test('view converts only exact product denials and propagates unexpected faults', async () => {
  for (const message of PRODUCT_DENIALS) {
    expect(isProductDenial(new Error(message))).toBe(true)
    expect(
      await view(async () => {
        throw new Error(message)
      })
    ).toBe('denied')
  }
  expect(await view(async () => ({ visible: true }))).toEqual({ visible: true })
  const fault = new Error('synthetic connection loss')
  await expect(
    view(async () => {
      throw fault
    })
  ).rejects.toBe(fault)
  expect(isProductDenial({ message: 'Workspace unavailable' })).toBe(false)
  expect(isProductDenial(null)).toBe(false)
})

test('pre-cutover folders contain the exact journal prefix and unchanged migration bytes', () => {
  const journal = readJournal()
  const cut = journal.entries.findIndex((entry) => entry.tag === CUTOVER_TAG)
  expect(cut).toBeGreaterThan(0)
  const folder = migrationsFolderBefore(CUTOVER_TAG)
  try {
    const actual = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'))
    expect(actual).toEqual({ ...journal, entries: journal.entries.slice(0, cut) })
    for (const entry of actual.entries) {
      expect(readFileSync(join(folder, `${entry.tag}.sql`))).toEqual(
        readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`))
      )
    }
    expect(existsSync(join(folder, `${CUTOVER_TAG}.sql`))).toBe(false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
  expect(() => migrationsFolderBefore('synthetic-missing-tag')).toThrow('is not in the journal')
})

test('cleanup aggregates close and drop failures while still removing owned folders', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rehearsal-multi-failure-'))
  const closeError = new Error('synthetic-close'),
    dropError = new Error('synthetic-drop')
  const failure = await disposeRehearsal(
    {
      connection: {
        close: async () => {
          throw closeError
        },
      },
      scratch: 'synthetic-only',
      preFolder: folder,
    },
    async () => {
      throw dropError
    }
  ).catch((error) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([closeError, dropError])
  expect(existsSync(folder)).toBe(false)
  await expect(
    disposeRehearsal({}, async () => {
      throw new Error('unexpected drop')
    })
  ).resolves.toBeUndefined()
})

test('teardown waits for delayed scenario resources then clears ownership once', async () => {
  const resources: RehearsalResources = {}
  const steps: string[] = []
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  }).then(() => {
    resources.scratch = 'late-synthetic-db'
    resources.connection = {
      close: async () => {
        steps.push('close')
      },
    }
    throw new Error('scenario failure is handled by its reader')
  })
  const cleanup = settleAndDispose(resources, pending, async (scratch) => {
    steps.push(`drop:${scratch}`)
  })
  expect(steps).toEqual([])
  release()
  await cleanup
  expect(steps).toEqual(['close', 'drop:late-synthetic-db'])
  expect(resources).toEqual({})
  await settleAndDispose(resources, undefined, async () => {
    throw new Error('duplicate drop')
  })
})
