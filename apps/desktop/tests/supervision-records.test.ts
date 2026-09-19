// Durable launch/exit records for supervision (ADR 0009 persistence table:
// "process/port identity | execution host supervisor | launch/exit/lease
// records"). Corruption is quarantined with the raw bytes retained, never
// silently dropped; retention is bounded.
import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createRecordStore, DEFAULT_MAX_RECORDS } from '../shell/src/supervision/records'

function launchRecord(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'launched' as const,
    at: '2026-09-18T00:00:00.000Z',
    componentId: 'local-control-plane',
    generation: 1,
    processRecordId: 'proc-1',
    identity: {
      pid: 4242,
      pidStartIdentity: 'start-4242',
      executableIdentity: 'bundle://cp@1.0.0',
    },
    processGroup: 'pgid-4242',
    ...overrides,
  }
}

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'adea-supervision-records-'))
}

describe('supervision record store', () => {
  test('round-trips launch and exit records across reopen', () => {
    const dir = temporaryDirectory()
    try {
      const store = createRecordStore(dir)
      store.append(launchRecord())
      store.append({
        kind: 'exited',
        at: '2026-09-18T00:01:00.000Z',
        componentId: 'local-control-plane',
        generation: 1,
        processRecordId: 'proc-1',
        expected: true,
        exitDetail: 'signalled',
      })

      const reopened = createRecordStore(dir)
      expect(reopened.list()).toHaveLength(2)
      expect(reopened.list()[0]).toMatchObject({ kind: 'launched', processRecordId: 'proc-1' })
      expect(reopened.list()[1]).toMatchObject({ kind: 'exited', expected: true })
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test('quarantines a corrupt line with its raw bytes retained and keeps the good records', () => {
    const dir = temporaryDirectory()
    try {
      const recordsPath = join(dir, 'records.jsonl')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(
        recordsPath,
        [
          JSON.stringify(launchRecord({ processRecordId: 'proc-good' })),
          '{"kind":"launched","at":"not-even-close"',
          'completely bogus line',
        ].join('\n') + '\n',
        { mode: 0o600 }
      )

      const store = createRecordStore(dir)
      expect(store.list().map((r) => (r as { processRecordId?: string }).processRecordId)).toEqual([
        'proc-good',
      ])
      expect(store.corruptCount()).toBe(2)
      // Raw corrupt bytes survive in the quarantine file for export/recovery.
      const quarantinePath = join(dir, 'records.corrupt.jsonl')
      expect(existsSync(quarantinePath)).toBe(true)
      expect(readFileSync(quarantinePath, 'utf8')).toContain(
        '"kind":"launched","at":"not-even-close"'
      )
      expect(readFileSync(quarantinePath, 'utf8')).toContain('completely bogus line')
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test('appends survive a torn final line from a crash mid-write', () => {
    const dir = temporaryDirectory()
    try {
      const store = createRecordStore(dir)
      store.append(launchRecord({ processRecordId: 'proc-1' }))
      // Simulate a crash mid-append: a partial line with no trailing newline.
      const recordsPath = join(dir, 'records.jsonl')
      const good = readFileSync(recordsPath, 'utf8')
      writeFileSync(recordsPath, good + '{"kind":"exited","at":"2026-09-18T00:0', { mode: 0o600 })

      const reopened = createRecordStore(dir)
      expect(reopened.list()).toHaveLength(1)
      expect(reopened.corruptCount()).toBe(1)

      // The store remains writable after recovery.
      reopened.append(launchRecord({ processRecordId: 'proc-2', generation: 2 }))
      expect(
        reopened.list().map((r) => (r as { processRecordId?: string }).processRecordId)
      ).toEqual(['proc-1', 'proc-2'])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test('retention is bounded: the oldest records prune beyond the cap', () => {
    const dir = temporaryDirectory()
    try {
      // The retention bound is injected so the prune semantics are proven
      // deterministically: driving the default cap of 1,000 needs 1,001+
      // real synchronous appends (~4 s of wall-clock I/O), which tripped the
      // runner timeout under load. Production keeps the 1,000 default.
      const maxRecords = 8
      const store = createRecordStore(dir, { maxRecords })
      for (let i = 0; i < maxRecords + 4; i++) {
        store.append(launchRecord({ processRecordId: `proc-${i}`, generation: i }))
      }
      const records = store.list()
      expect(records.length).toBe(maxRecords)
      const first = records[0] as { processRecordId?: string }
      const last = records[records.length - 1] as { processRecordId?: string }
      expect(last.processRecordId).toBe(`proc-${maxRecords + 3}`)
      expect(first.processRecordId).toBe('proc-4')
      // The on-disk journal matches the bounded in-memory view.
      expect(readFileSync(join(dir, 'records.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
        records.length
      )
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })

  test('the production retention cap stays the 1,000-record default', () => {
    expect(DEFAULT_MAX_RECORDS).toBe(1_000)
  })

  test('records live owner-only', () => {
    const dir = temporaryDirectory()
    try {
      createRecordStore(dir)
      // Owner read/write only (0o600); the directory itself is 0o700.
      expect(statSync(join(dir, 'records.jsonl')).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})
