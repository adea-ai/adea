import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDurableJsonStore } from '../shell/src/dev-runtime/host-store'

describe('durable host store permissions', () => {
  test('tightens an existing store before reading it', () => {
    const root = mkdtempSync(join(tmpdir(), 'adea-host-store-'))
    try {
      const directory = join(root, 'state')
      const file = join(directory, 'records.json')
      mkdirSync(directory, { recursive: true, mode: 0o755 })
      writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, savedAt: '', records: [{ value: 'ok' }] }),
        { mode: 0o644 }
      )

      const store = createDurableJsonStore<{ value: string }>({
        file,
        schemaVersion: 1,
        label: 'test',
      })
      expect(store.load().records).toEqual([{ value: 'ok' }])
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
