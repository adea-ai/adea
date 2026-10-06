/*
 * Editor save-conflict tests (#677 — the UI-lane half of the #399
 * "terminal + editor concurrent edit" acceptance case). The provider's
 * compare-and-swap refusal is proven in the desktop suite; these tests pin
 * what the editor surface does with that refusal when a live external writer
 * (a terminal, an agent) changed the file between read and save: the typed
 * conflict surfaces with local edits kept, the two explicit resolutions
 * (Reload / Overwrite) behave as their records state, and the pinned
 * identity chain stays continuous so later saves never re-conflict.
 */
import { describe, expect, test } from 'bun:test'

import type { FileIdentity } from '@adea-ai/types/dev-runtime'

import {
  classifySaveReply,
  conflictBannerCopy,
  conflictResolution,
  CONFLICT_RESOLUTIONS,
  editorCasAfterOverwritePin,
  editorCasAfterReload,
  editorCasAfterSave,
  initialEditorCas,
  overwriteAuditCopy,
} from '../src/editor/save-conflict'

function identity(mtime: string): FileIdentity {
  return { mtimeNs: mtime, size: '128' }
}

const V1 = identity('1000') // what the editor read
const V2 = identity('2000') // what the terminal wrote behind it
const V3 = identity('3000') // what the editor's own save produced

function refusal(code: string): unknown {
  return { error: { code, message: `refused: ${code}`, retryable: false } }
}

describe('editor save conflict (terminal + editor concurrent edit)', () => {
  test('a live external write surfaces as the typed conflict, keeping local edits and the pin', () => {
    const opened = initialEditorCas(V1)
    expect(opened).toEqual({ pinnedIdentity: V1, conflict: false })

    // The terminal writes the file; the editor's save pins V1 and refuses.
    const decision = classifySaveReply(refusal('file_changed'))
    expect(decision).toEqual({ kind: 'conflict' })

    const conflicted = editorCasAfterSave(opened, decision)
    expect(conflicted.conflict).toBe(true)
    expect(conflicted.pinnedIdentity).toEqual(V1)
  })

  test('a conflicted save never resolves itself: only the explicit resolutions clear it', () => {
    const conflicted = { pinnedIdentity: V1, conflict: false }
    const afterConflict = editorCasAfterSave(conflicted, { kind: 'conflict' })

    // Any other rejection leaves the state exactly as it was (notice only).
    expect(editorCasAfterSave(afterConflict, classifySaveReply(refusal('stale_generation')))).toBe(
      afterConflict
    )

    // And a saved write clears the conflict and repins in one transition.
    expect(editorCasAfterSave(afterConflict, { kind: 'saved' }, V3).pinnedIdentity).toEqual(V3)
  })

  test('Reload discards local edits by re-pinning to the disk identity', () => {
    const record = conflictResolution('reload')
    expect(record).toMatchObject({ discardsLocalEdits: true, requiresFreshIdentity: false })

    const conflicted = editorCasAfterSave(initialEditorCas(V1), { kind: 'conflict' })
    const reloaded = editorCasAfterReload(V2)
    expect(reloaded).toEqual({ pinnedIdentity: V2, conflict: false })
    expect(reloaded.pinnedIdentity).not.toEqual(conflicted.pinnedIdentity)
  })

  test('Overwrite observes a fresh identity before retrying, and the chain continues', () => {
    const record = conflictResolution('overwrite')
    expect(record).toMatchObject({ discardsLocalEdits: false, requiresFreshIdentity: true })

    // Step one: pin the freshly observed live identity (the terminal's V2).
    const repinned = editorCasAfterOverwritePin(V2)
    expect(repinned).toEqual({ pinnedIdentity: V2, conflict: false })

    // Step two: the retrying save is itself a CAS over V2 and lands V3.
    const saved = editorCasAfterSave(repinned, { kind: 'saved' }, V3)
    expect(saved).toEqual({ pinnedIdentity: V3, conflict: false })

    // Continuity: the next save pins V3, so it cannot re-conflict against
    // the file the editor itself wrote.
    expect(editorCasAfterSave(saved, { kind: 'saved' }, identity('4000')).pinnedIdentity).toEqual(
      identity('4000')
    )
  })

  test('a save refused after the overwrite pin surfaces the conflict again instead of overwriting', () => {
    // The external writer wins twice: the overwrite pinned V2, the terminal
    // wrote V2.5 before the retry — the retry must refuse visibly.
    const repinned = editorCasAfterOverwritePin(identity('2500'))
    const refusedAgain = editorCasAfterSave(repinned, classifySaveReply(refusal('file_changed')))
    expect(refusedAgain.conflict).toBe(true)
    expect(refusedAgain.pinnedIdentity).toEqual(identity('2500'))
  })

  test('only file_changed is a conflict; every other refusal is a typed error', () => {
    expect(classifySaveReply(refusal('stale_generation'))).toEqual({
      kind: 'error',
      code: 'stale_generation',
      message: 'refused: stale_generation',
    })
    expect(classifySaveReply(refusal('path_denied')).kind).toBe('error')
    expect(classifySaveReply(undefined).kind).toBe('error')
    expect(classifySaveReply(null).kind).toBe('error')
    expect(classifySaveReply({ error: {} })).toEqual({
      kind: 'error',
      code: 'error',
      message: 'operation failed',
    })
  })

  test('the surface records name both resolutions and the banner states the external-writer case', () => {
    expect(CONFLICT_RESOLUTIONS.map((resolution) => resolution.action)).toEqual([
      'reload',
      'overwrite',
    ])
    expect(conflictResolution('reload')).toBeDefined()
    expect(conflictResolution('overwrite')).toBeDefined()
    expect(conflictResolution('save-as')).toBeUndefined()
    expect(conflictBannerCopy()).toContain('changed on disk')
    expect(overwriteAuditCopy('src/app.ts')).toContain('src/app.ts')
    expect(overwriteAuditCopy('src/app.ts')).toContain('explicit')
  })
})
