// Memory provenance and audience guards (ADR 0012; docs/specs/local-content.md
// "Workspace memory"): promotion preserves the entry's provenance and
// workspace audience, refuses a presented provenance change, stale revisions
// and repeat promotion, and an injection switch (the closest thing memory has
// to a persona/connection change) never rewrites or broadens an entry.
import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decideMemoryPromotion,
  isMemoryAudience,
  requireMemoryPromotion,
  type MemoryProvenanceRefusal,
  type MemoryProvenanceRecord,
} from '../shell/src/memory/provenance'
import { createMemoryStore } from '../shell/src/memory/store'

const WORKSPACE_A = '00000000-0000-4000-8000-00000000000a'
const WORKSPACE_B = '00000000-0000-4000-8000-00000000000b'
const FOREIGN_ENTRY = '00000000-0000-4000-8000-0000000000ff'

function withStore(
  run: (context: { dir: string; store: ReturnType<typeof createMemoryStore> }) => void
) {
  const dir = mkdtempSync(join(tmpdir(), 'adea-memory-provenance-'))
  const key = randomBytes(32)
  try {
    run({ dir, store: createMemoryStore({ contentDir: dir, key: () => key }) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function provenanceRecord(overrides: Partial<MemoryProvenanceRecord> = {}): MemoryProvenanceRecord {
  return {
    id: FOREIGN_ENTRY,
    provenance: 'agent',
    revision: 1,
    status: 'pending',
    workspaceId: WORKSPACE_A,
    ...overrides,
  }
}

function refusalOf(run: () => unknown): MemoryProvenanceRefusal | undefined {
  try {
    run()
  } catch (error) {
    return (error as { reason?: MemoryProvenanceRefusal }).reason
  }
  return undefined
}

describe('memory provenance and audience guard', () => {
  test('promotion carries the entry provenance and workspace through unchanged', () => {
    const decision = decideMemoryPromotion({
      entry: provenanceRecord(),
      authorizedWorkspaceId: WORKSPACE_A,
      expectedRevision: 1,
    })
    expect(decision.allowed).toBe(true)
    if (!decision.allowed) return
    expect(decision.plan).toEqual({
      entryId: FOREIGN_ENTRY,
      audienceWorkspaceId: WORKSPACE_A,
      provenance: 'agent',
      from: 'pending',
      to: 'active',
      observedRevision: 1,
      nextRevision: 2,
    })
    // User-authored memory promotes the same way: the guard never rewrites it.
    const userEntry = provenanceRecord({ provenance: 'user' })
    const userDecision = decideMemoryPromotion({
      entry: userEntry,
      authorizedWorkspaceId: WORKSPACE_A,
      expectedRevision: 1,
    })
    expect(userDecision.allowed && userDecision.plan.provenance).toBe('user')
  })

  test('a presented provenance change, foreign audience and stale revision all refuse', () => {
    expect(
      decideMemoryPromotion({
        entry: provenanceRecord(),
        authorizedWorkspaceId: WORKSPACE_A,
        expectedRevision: 1,
        nextProvenance: 'user',
      })
    ).toEqual({ allowed: false, reason: 'memory_provenance_mismatch' })
    expect(
      decideMemoryPromotion({
        entry: provenanceRecord({ workspaceId: WORKSPACE_B }),
        authorizedWorkspaceId: WORKSPACE_A,
        expectedRevision: 1,
      })
    ).toEqual({ allowed: false, reason: 'memory_audience_mismatch' })
    expect(
      decideMemoryPromotion({
        entry: provenanceRecord(),
        authorizedWorkspaceId: WORKSPACE_A,
        expectedRevision: 2,
      })
    ).toEqual({ allowed: false, reason: 'memory_stale_revision' })
    expect(
      decideMemoryPromotion({
        entry: provenanceRecord({ status: 'active', revision: 1 }),
        authorizedWorkspaceId: WORKSPACE_A,
        expectedRevision: 1,
      })
    ).toEqual({ allowed: false, reason: 'memory_invalid_state' })
  })

  test('requireMemoryPromotion throws the typed reason and never mutates', () => {
    const record = provenanceRecord()
    expect(
      refusalOf(() =>
        requireMemoryPromotion({
          entry: record,
          authorizedWorkspaceId: WORKSPACE_A,
          expectedRevision: 2,
        })
      )
    ).toBe('memory_stale_revision')
    expect(record.status).toBe('pending')
    expect(record.revision).toBe(1)
  })

  test('the store accepts a proposal without relabelling it', () => {
    withStore(({ store }) => {
      const proposed = store.propose(WORKSPACE_A, { text: 'agent learned this' })
      const accepted = store.accept(WORKSPACE_A, {
        entryId: proposed.id,
        expectedRevision: proposed.revision,
      })
      expect(accepted).toMatchObject({
        id: proposed.id,
        source: 'agent',
        status: 'active',
        workspaceId: WORKSPACE_A,
        text: 'agent learned this',
        revision: 2,
      })
      expect(accepted.createdAt).toBe(proposed.createdAt)
      // A foreign workspace reads the same entry as absent, never promoted.
      expect(isMemoryAudience(accepted, WORKSPACE_B)).toBe(false)
      expect(store.list(WORKSPACE_B).entries).toEqual([])
    })
  })

  test('an injection switch changes delivery only, never provenance or audience', () => {
    withStore(({ store }) => {
      const entry = store.create(WORKSPACE_A, { text: 'kept through the switch' })
      store.setInjectionEnabled(WORKSPACE_A, false)
      expect(store.list(WORKSPACE_A).entries).toEqual([entry])
      expect(store.preamble(WORKSPACE_A)).toBeUndefined()
      store.setInjectionEnabled(WORKSPACE_A, true)
      const restored = store.list(WORKSPACE_A).entries[0]!
      expect(restored).toEqual(entry)
      expect(store.preamble(WORKSPACE_A)?.text).toContain('kept through the switch')
      // A sibling workspace with its own entries never receives them.
      expect(store.list(WORKSPACE_B).entries).toEqual([])
      expect(store.preamble(WORKSPACE_B)).toBeUndefined()
    })
  })
})
